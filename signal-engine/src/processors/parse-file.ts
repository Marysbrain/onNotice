import type { Env } from "../env.js";
import { insertRecord } from "../db/records.js";
import { matchArbRespondent } from "../lib/taxonomy.js";

export interface ParseFilePayload {
  r2Key: string;
  sourceId: string;
  provider: string; // aaa | jams
  sourceUrl: string;
  archiveUrl?: string | null;
}

// Result tells the job runner what happened. deferred = xlsx, handled by the CI
// escape hatch, not a failure.
export interface ParseResult {
  deferred: boolean;
  records: number;
}

// Process a downloaded arbitration file. CSV is cheap and parsed inline. XLSX is
// a zip and a full parse does not fit the 10ms free CPU budget, so we defer it to
// scripts/parse-xlsx.mjs (GitHub Actions). We detect the format by sniffing the
// first bytes: a zip (xlsx) starts with "PK".
export async function processParseFile(env: Env, payload: ParseFilePayload): Promise<ParseResult> {
  // Sniff the first 2 bytes with a ranged read so we do not pull a large xlsx
  // into the isolate just to check its type.
  const head = await env.RAW.get(payload.r2Key, { range: { offset: 0, length: 2 } });
  if (!head) throw new Error(`R2 object missing: ${payload.r2Key}`);
  const headBytes = new Uint8Array(await head.arrayBuffer());
  const isZip = headBytes[0] === 0x50 && headBytes[1] === 0x4b; // "PK"
  if (isZip) {
    // xlsx. Leave the raw file in R2 for the CI escape hatch to parse.
    return { deferred: true, records: 0 };
  }

  const obj = await env.RAW.get(payload.r2Key);
  if (!obj) throw new Error(`R2 object missing: ${payload.r2Key}`);
  const text = await obj.text();
  const rows = parseCsv(text);
  if (rows.length < 2) return { deferred: false, records: 0 };

  const header = rows[0]!.map((h) => h.toLowerCase());
  const respIdx = findColumn(header, RESPONDENT_COLUMNS);
  if (respIdx < 0) return { deferred: false, records: 0 };
  const caseIdx = findColumn(header, CASE_ID_COLUMNS);
  const filedIdx = findColumn(header, FILING_DATE_COLUMNS);

  const capture = Math.floor(Date.now() / 1000);
  let created = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const company = (row[respIdx] ?? "").trim();
    if (!company) continue;
    const carrier = matchArbRespondent(company);
    if (!carrier) continue;

    // The quarterly files are cumulative, so the same case reappears in every
    // later file. Dedupe on the provider's case id when the file carries one.
    const caseId = caseIdx >= 0 ? (row[caseIdx] ?? "").trim() : "";
    const dedupeKey = caseId
      ? `arb:${payload.provider}:${caseId}`
      : `arb:${payload.provider}:${payload.r2Key}:${i}`;

    const excerpt = `${company} | ${header.map((h, k) => `${h}=${row[k] ?? ""}`).join("; ")}`.slice(0, 500);
    const inserted = await insertRecord(env, {
      dedupeKey,
      sourceId: payload.sourceId,
      sourceUrl: payload.sourceUrl,
      captureDate: capture,
      recordDate: filedIdx >= 0 ? parseArbDate(row[filedIdx] ?? "") : null,
      excerpt,
      archiveUrl: payload.archiveUrl ?? null,
      carrier,
      // Named respondent in an official arbitration file. Primary source.
      vettingStatus: "verified_primary",
      rawRef: payload.r2Key,
    });
    if (inserted) created++;
  }
  return { deferred: false, records: created };
}

// Column aliases, checked in order. AAA uses "Nonconsumer" for the business
// party (confirmed against the Q1 2026 file). Bare "business" or "name" are
// never used: they collide with "Claim Amt Business" and "Arbitrator Name".
export const RESPONDENT_COLUMNS = ["nonconsumer", "non-consumer", "respondent", "company"];
export const CASE_ID_COLUMNS = ["case id", "case number", "case no", "reference no"];
export const FILING_DATE_COLUMNS = ["filing date", "date filed", "file date"];

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// AAA writes dates as DD-MON-YY ("02-JUN-21"). Fall back to Date.parse for
// ISO or US formats. Returns epoch seconds or null.
export function parseArbDate(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase()];
    if (mon === undefined) return null;
    const yy = Number(m[3]);
    const year = m[3]!.length === 2 ? 2000 + yy : yy;
    return Math.floor(Date.UTC(year, mon, Number(m[1])) / 1000);
  }
  const parsed = Date.parse(t);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

export function findColumn(header: string[], wants: string[]): number {
  for (const w of wants) {
    const idx = header.findIndex((h) => h.includes(w));
    if (idx >= 0) return idx;
  }
  return -1;
}

// Minimal RFC-4180-ish CSV parser. Handles quotes, escaped quotes, embedded
// commas and newlines. Small inputs only; large files come as xlsx anyway.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
