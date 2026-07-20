import type { Env } from "../env.js";
import type { FetchImpl } from "../lib/http.js";
import { insertRecord } from "../db/records.js";
import { getConfigNumber, spendBudget } from "../lib/config.js";
import { matchCarrier, searchPhrases, carrierList } from "../lib/taxonomy.js";

// CourtListener v4 search backfill. Budget-aware: free tier is 5/min, 50/hr,
// 125/day. We spend a per-day budget counter in KV before each call and stop
// when the day is exhausted, resuming tomorrow from the same cursor. Per run we
// make at most CALLS_PER_RUN calls, which keeps us far under 5/min given the
// */5 runner cadence.
//
// Optional COURTLISTENER_TOKEN raises limits but the backfill works without it.

const BASE = "https://www.courtlistener.com/api/rest/v4/search/";
const DAILY_DEFAULT = 125;
const CALLS_PER_RUN = 3;

// Search terms: carrier names plus promo/credit phrases.
export function courtlistenerQueries(): string[] {
  const carriers = carrierList().map((c) => c.display);
  const phrases = searchPhrases();
  const out: string[] = [];
  for (const c of carriers) {
    for (const p of phrases.slice(0, 2)) out.push(`"${c}" "${p}"`);
  }
  return out;
}

export function buildCourtListenerUrl(base: string, query: string, page: number): string {
  const params = new URLSearchParams({ q: query, type: "r", order_by: "dateFiled desc", page: String(page) });
  return `${base}?${params.toString()}`;
}

export interface DocketItem {
  caseName: string;
  court: string;
  dateFiled: string;
  docketNumber: string;
  url: string;
}

export function parseCourtListener(json: unknown): DocketItem[] {
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  const out: DocketItem[] = [];
  for (const r of results) {
    const row = r as Record<string, unknown>;
    const abs = typeof row.absolute_url === "string" ? row.absolute_url : "";
    const url = abs ? (abs.startsWith("http") ? abs : `https://www.courtlistener.com${abs}`) : "";
    if (!url) continue;
    out.push({
      caseName: String(row.caseName ?? row.caseNameFull ?? ""),
      court: String(row.court ?? row.court_id ?? ""),
      dateFiled: String(row.dateFiled ?? ""),
      docketNumber: String(row.docketNumber ?? ""),
      url,
    });
  }
  return out;
}

interface Cursor {
  termIndex?: number;
  page?: number;
}

export async function runCourtListenerBackfill(
  env: Env,
  deps: { fetchImpl?: FetchImpl } = {}
): Promise<{ inserted: number; calls: number; budgetExhausted: boolean; more: boolean; cursorKey: string }> {
  const doFetch = deps.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const dailyLimit = await getConfigNumber(env, "COURTLISTENER_DAILY", DAILY_DEFAULT);
  const queries = courtlistenerQueries();

  const raw = await env.CONFIG.get("cursor:courtlistener");
  const cursor: Cursor = raw ? (JSON.parse(raw) as Cursor) : {};
  let termIndex = cursor.termIndex ?? 0;
  let page = cursor.page ?? 1;

  const headers: Record<string, string> = { "User-Agent": "carriers-on-notice/0.1 (+contact@athipp.com)", Accept: "application/json" };
  if (env.COURTLISTENER_TOKEN) headers["Authorization"] = `Token ${env.COURTLISTENER_TOKEN}`;

  let inserted = 0;
  let calls = 0;
  let budgetExhausted = false;
  const capture = Math.floor(Date.now() / 1000);

  while (calls < CALLS_PER_RUN && termIndex < queries.length) {
    const spend = await spendBudget(env, "courtlistener", dailyLimit);
    if (!spend.allowed) {
      budgetExhausted = true;
      break;
    }
    calls++;

    let items: DocketItem[] = [];
    try {
      const res = await doFetch(buildCourtListenerUrl(BASE, queries[termIndex]!, page), { headers });
      if (res.ok) items = parseCourtListener(await res.json());
    } catch {
      items = [];
    }

    for (const item of items) {
      const inrec = await insertRecord(env, {
        dedupeKey: `cl:${item.url}`,
        sourceId: "courtlistener",
        sourceUrl: item.url,
        captureDate: capture,
        recordDate: item.dateFiled ? Math.floor(Date.parse(item.dateFiled) / 1000) || null : null,
        excerpt: `${item.caseName} | ${item.court} | docket ${item.docketNumber} | filed ${item.dateFiled}`.slice(0, 500),
        carrier: matchCarrier(item.caseName),
        vettingStatus: "single_source",
      });
      if (inrec) inserted++;
    }

    // Empty page means this term is exhausted; move to the next term.
    if (items.length === 0) {
      termIndex++;
      page = 1;
    } else {
      page++;
    }
  }

  await env.CONFIG.put("cursor:courtlistener", JSON.stringify({ termIndex, page } satisfies Cursor));
  const more = termIndex < queries.length && !budgetExhausted;
  return { inserted, calls, budgetExhausted, more, cursorKey: `${termIndex}:${page}` };
}
