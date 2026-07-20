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
  const respIdx = findColumn(header, ["respondent", "business", "non-consumer", "company", "name"]);
  if (respIdx < 0) return { deferred: false, records: 0 };

  const capture = Math.floor(Date.now() / 1000);
  let created = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const company = (row[respIdx] ?? "").trim();
    if (!company) continue;
    const carrier = matchArbRespondent(company);
    if (!carrier) continue;

    const excerpt = `${company} | ${header.map((h, k) => `${h}=${row[k] ?? ""}`).join("; ")}`.slice(0, 500);
    const inserted = await insertRecord(env, {
      dedupeKey: `arb:${payload.provider}:${payload.r2Key}:${i}`,
      sourceId: payload.sourceId,
      sourceUrl: payload.sourceUrl,
      captureDate: capture,
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

function findColumn(header: string[], wants: string[]): number {
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
