// ESCAPE HATCH. Runs in GitHub Actions (Node), not in the Worker.
//
// Why this exists: a full xlsx parse does not fit the Cloudflare Workers free
// 10ms CPU budget. The Worker downloads the quarterly AAA/JAMS file to R2 and
// marks the parse job "deferred". This script does the heavy parse in CI and
// writes carrier respondent rows back to D1 over the HTTP query API.
//
// Zero cost: GitHub Actions is free for this workload. exceljs is a dev/CI
// dependency only, never bundled into the Worker.
//
// Install (in CI):   npm i exceljs
// Run:               node scripts/parse-xlsx.mjs <fileUrlOrPath> <provider>
//   provider = aaa | jams
//
// Required env (set as GitHub Actions secrets):
//   CLOUDFLARE_API_TOKEN   token with D1 edit on this account
//   CLOUDFLARE_ACCOUNT_ID  account id
//   D1_DATABASE_ID         database id of signal_engine
//
// dedupe: records use INSERT OR IGNORE on records.dedupe_key. Keys here match
// the scheme so re-running a quarter is a no-op. The Worker only writes CSV
// rows inline, so there is no collision with xlsx rows written here.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

// Load taxonomy so carrier matching stays identical to the Worker.
const taxonomy = require("../taxonomy.json");

// Word-boundary matching, identical in behavior to src/lib/taxonomy.ts.
// Substring matching misattributes ("Metropolitan" is not "Metro").
function termRegex(term) {
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`);
}

function matchArbRespondent(company) {
  const hay = String(company).toLowerCase();
  for (const c of taxonomy.carriers) {
    if (c.arb_respondent_patterns.some((p) => termRegex(p).test(hay))) return c.id;
  }
  return null;
}

async function loadWorkbook(src) {
  let ExcelJS;
  try {
    ExcelJS = require("exceljs");
  } catch {
    console.error("exceljs not installed. Run: npm i exceljs");
    process.exit(2);
  }
  const wb = new ExcelJS.Workbook();
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src, { headers: { "User-Agent": "carriers-on-notice/0.1 (+contact@athipp.com)" } });
    if (!res.ok) throw new Error(`fetch ${src} -> ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await wb.xlsx.load(buf);
  } else {
    await wb.xlsx.load(await readFile(src));
  }
  return wb;
}

function findColumn(header, wants) {
  const lower = header.map((h) => String(h ?? "").toLowerCase());
  for (const w of wants) {
    const idx = lower.findIndex((h) => h.includes(w));
    if (idx >= 0) return idx;
  }
  return -1;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// AAA writes dates as DD-MON-YY ("02-JUN-21"). exceljs may also hand us a Date
// for date-typed cells. Returns epoch seconds or null.
function parseArbDate(v) {
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  const t = String(v ?? "").trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon === undefined) return null;
    const yy = Number(m[3]);
    const year = m[3].length === 2 ? 2000 + yy : yy;
    return Math.floor(Date.UTC(year, mon, Number(m[1])) / 1000);
  }
  const parsed = Date.parse(t);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

async function d1Query(sql, params) {
  // DRY_RUN=1 parses and counts without touching D1. For validating a new
  // quarterly file's shape before wiring credentials.
  if (process.env.DRY_RUN) return null;
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID } = process.env;
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !D1_DATABASE_ID) {
    throw new Error("Missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID");
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`D1 query failed: ${JSON.stringify(data.errors ?? data)}`);
  return data.result;
}

async function main() {
  const [src, provider] = process.argv.slice(2);
  if (!src || !provider) {
    console.error("usage: node scripts/parse-xlsx.mjs <fileUrlOrPath> <provider: aaa|jams>");
    process.exit(1);
  }
  const fileId = path.basename(src.split("?")[0]);
  const capture = Math.floor(Date.now() / 1000);

  const wb = await loadWorkbook(src);
  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error("no worksheet");

  const rows = [];
  sheet.eachRow((row) => rows.push(row.values.slice(1))); // exceljs pads index 0
  if (rows.length < 2) {
    console.log("no data rows");
    return;
  }
  const header = rows[0].map((h) => String(h ?? ""));
  // AAA's business-party column is "Nonconsumer" (confirmed against the Q1 2026
  // file). Bare "business"/"name" collide with "Claim Amt Business" and
  // "Arbitrator Name", so they are never used as aliases.
  const respIdx = findColumn(header, ["nonconsumer", "non-consumer", "respondent", "company"]);
  if (respIdx < 0) {
    console.error("no respondent-like column found. Headers:", header);
    process.exit(3);
  }
  const caseIdx = findColumn(header, ["case id", "case number", "case no", "reference no"]);
  const filedIdx = findColumn(header, ["filing date", "date filed", "file date"]);

  let created = 0;
  for (let i = 1; i < rows.length; i++) {
    const company = String(rows[i][respIdx] ?? "").trim();
    if (!company) continue;
    const carrier = matchArbRespondent(company);
    if (!carrier) continue;

    // Cumulative quarterly files repeat cases; dedupe on the provider case id.
    const caseId = caseIdx >= 0 ? String(rows[i][caseIdx] ?? "").trim() : "";
    const dedupeKey = caseId ? `arb:${provider}:${caseId}` : `arb:${provider}:${fileId}:${i}`;
    const recordDate = filedIdx >= 0 ? parseArbDate(rows[i][filedIdx]) : null;

    const excerpt = `${company} | ${header.map((h, k) => `${h}=${rows[i][k] ?? ""}`).join("; ")}`.slice(0, 500);
    await d1Query(
      `INSERT OR IGNORE INTO records
        (dedupe_key, source_id, source_url, capture_date, record_date, excerpt, carrier, vetting_status, raw_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'verified_primary', ?)`,
      [dedupeKey, `${provider}_arb`, src, capture, recordDate, excerpt, carrier, fileId]
    );
    created++;
  }
  console.log(`wrote ${created} carrier respondent record(s) from ${fileId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
