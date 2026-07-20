import type { Env } from "../env.js";
import { enabledSources, insertRecord, touchSource } from "../db/records.js";
import { searchPhrases } from "../lib/taxonomy.js";

// SEC EDGAR full-text search. We resolve carrier CIKs once and cache them in the
// source cursor, then poll the FTS API for new filings that match our promo
// terms. SEC fair-access rules require a real User-Agent ("CompanyName email")
// and cap traffic at 10 req/sec. We do far less: a few requests per day.
//
// The User-Agent comes from env.SEC_USER_AGENT. There is no built-in default
// that looks real. If it is unset we skip, because SEC will (rightly) block an
// anonymous client.

const TICKERS = ["T", "VZ", "TMUS"];
const MAX_RECORDS_PER_RUN = 20;

interface EdgarCursor {
  ciks?: Record<string, string>; // ticker -> zero-padded 10-digit CIK
  since?: string; // YYYY-MM-DD, only pull filings on/after this date
  phraseIdx?: number; // rotate through search phrases across runs
}

export interface EdgarItem {
  accession: string;
  url: string;
  title: string;
  fileDate: string;
  cik: string;
}

// Pull a CIK for a ticker out of SEC's company_tickers.json without a full
// JSON.parse of the whole ~800KB file. A targeted regex is far cheaper on CPU.
// The file entries look like: {"cik_str":732717,"ticker":"T","title":"AT&T INC."}
export function resolveCikFromTickerFile(text: string, ticker: string): string | null {
  const re = new RegExp(`"cik_str":(\\d+),"ticker":"${ticker}"`, "i");
  const m = text.match(re);
  if (!m || !m[1]) return null;
  return m[1].padStart(10, "0");
}

// Parse an EDGAR FTS response into items. Builds the canonical Archives URL from
// the _id ("accession:filename") and the filing CIK.
export function parseEdgarHits(json: unknown): EdgarItem[] {
  const hits = (json as { hits?: { hits?: unknown[] } })?.hits?.hits;
  if (!Array.isArray(hits)) return [];
  const items: EdgarItem[] = [];
  for (const h of hits) {
    const hit = h as { _id?: string; _source?: Record<string, unknown> };
    const id = hit._id;
    const src = hit._source ?? {};
    if (!id) continue;
    const [accession, filename] = id.split(":");
    if (!accession) continue;
    const ciks = Array.isArray(src.ciks) ? (src.ciks as string[]) : [];
    const cikPadded = ciks[0] ?? "";
    const cikPlain = cikPadded.replace(/^0+/, "") || cikPadded;
    const accNoDash = accession.replace(/-/g, "");
    const url = filename
      ? `https://www.sec.gov/Archives/edgar/data/${cikPlain}/${accNoDash}/${filename}`
      : `https://www.sec.gov/Archives/edgar/data/${cikPlain}/${accNoDash}/`;
    const names = Array.isArray(src.display_names) ? (src.display_names as string[]).join(", ") : "";
    const form = typeof src.form === "string" ? src.form : (src.file_type as string) ?? "";
    const fileDate = typeof src.file_date === "string" ? src.file_date : "";
    items.push({
      accession,
      url,
      title: [names, form, fileDate].filter(Boolean).join(" | "),
      fileDate,
      cik: cikPadded,
    });
  }
  return items;
}

export async function collectEdgar(env: Env): Promise<{ source: string; new: number; note?: string }[]> {
  if (!env.SEC_USER_AGENT) {
    return [{ source: "sec_edgar", new: 0, note: "SEC_USER_AGENT unset, skipped" }];
  }
  const ua = env.SEC_USER_AGENT;
  const sources = await enabledSources(env, "edgar_fts");
  const out: { source: string; new: number; note?: string }[] = [];

  for (const src of sources) {
    let cursor = parseCursor(src.cursor);
    let added = 0;
    try {
      // Resolve CIKs once, then cache.
      if (!cursor.ciks || Object.keys(cursor.ciks).length < TICKERS.length) {
        const tickersRes = await fetch("https://www.sec.gov/files/company_tickers.json", {
          headers: { "User-Agent": ua },
        });
        if (tickersRes.ok) {
          const text = await tickersRes.text();
          const ciks: Record<string, string> = {};
          for (const t of TICKERS) {
            const cik = resolveCikFromTickerFile(text, t);
            if (cik) ciks[t] = cik;
          }
          cursor = { ...cursor, ciks };
        }
      }

      const phrases = searchPhrases();
      const phraseIdx = (cursor.phraseIdx ?? 0) % phrases.length;
      const phrase = phrases[phraseIdx]!;
      const since = cursor.since ?? isoDaysAgo(120);
      let maxDate = since;

      const capture = Math.floor(Date.now() / 1000);
      for (const ticker of TICKERS) {
        const cik = cursor.ciks?.[ticker];
        if (!cik) continue;
        if (added >= MAX_RECORDS_PER_RUN) break;

        const q = encodeURIComponent(`"${phrase}"`);
        const url = `https://efts.sec.gov/LATEST/search-index?q=${q}&ciks=${cik}&startdt=${since}&enddt=${isoDaysAgo(0)}`;
        const res = await fetch(url, { headers: { "User-Agent": ua, Accept: "application/json" } });
        if (!res.ok) continue;
        const items = parseEdgarHits(await res.json());

        for (const item of items) {
          if (added >= MAX_RECORDS_PER_RUN) break;
          if (item.fileDate && item.fileDate > maxDate) maxDate = item.fileDate;
          const inserted = await insertRecord(env, {
            dedupeKey: `edgar:${item.accession}:${phraseIdx}`,
            sourceId: src.id,
            sourceUrl: item.url,
            captureDate: capture,
            recordDate: item.fileDate ? Math.floor(Date.parse(item.fileDate) / 1000) : null,
            excerpt: `${item.title} (matched "${phrase}")`.slice(0, 500),
            carrier: tickerToCarrier(ticker),
            // Official SEC filing, company named. Primary source.
            vettingStatus: "verified_primary",
          });
          if (inserted) added++;
        }
      }

      await touchSource(
        env,
        src.id,
        JSON.stringify({ ...cursor, since: maxDate, phraseIdx: phraseIdx + 1 } satisfies EdgarCursor)
      );
    } catch {
      // Drop this run. Cursor unchanged so the next run retries from the same point.
    }
    out.push({ source: src.id, new: added });
  }
  return out;
}

function tickerToCarrier(ticker: string): string | null {
  if (ticker === "T") return "att";
  if (ticker === "VZ") return "verizon";
  if (ticker === "TMUS") return "tmobile";
  return null;
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

function parseCursor(raw: string | null): EdgarCursor {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as EdgarCursor;
  } catch {
    return {};
  }
}
