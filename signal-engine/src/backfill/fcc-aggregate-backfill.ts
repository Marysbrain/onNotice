import type { Env } from "../env.js";
import type { FetchImpl } from "../lib/http.js";
import { getConfigString } from "../lib/config.js";
import { addMonths, currentMonth, monthStartISO, monthEndISO } from "../lib/months.js";
import { insertFccMonthly, type FccAggRow } from "../db/fcc.js";

// FCC aggregate backfill. THE architecture decision: we never store row-level FCC
// complaints. We pull monthly counts by state and by top zips with Socrata
// group-by queries and store them in fcc_monthly_aggregates. One month per run,
// re-enqueued until it reaches the present month.
//
// date_trunc_ym is a documented SoQL function (verified against dev.socrata.com
// on 2026-07-20): it truncates a floating timestamp to the first of the month.

const EARLIEST_DEFAULT = "2014-11";
const ZIP_LIMIT = 500; // top zips per month; the hot ones are what the map needs
const BASE = "https://opendata.fcc.gov/resource/3xyp-aqkj.json";

// Build a group-by query for one dimension (state or zip) over one month window.
export function buildFccAggQuery(
  baseUrl: string,
  dimension: "state" | "zip",
  monthStart: string,
  monthEnd: string,
  limit: number
): string {
  const params = new URLSearchParams({
    $select: `${dimension}, date_trunc_ym(ticket_created) AS month, count(*) AS count`,
    $where: `issue_type='Phone' AND ticket_created >= '${monthStart}' AND ticket_created < '${monthEnd}' AND ${dimension} IS NOT NULL`,
    $group: `${dimension}, date_trunc_ym(ticket_created)`,
    $order: "count DESC",
    $limit: String(limit),
  });
  return `${baseUrl}?${params.toString()}`;
}

// Socrata returns month as '2015-03-01T00:00:00.000'. Normalize to 'YYYY-MM'.
function toMonthKey(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.length >= 7 ? raw.slice(0, 7) : fallback;
}

export async function runFccAggregateBackfill(
  env: Env,
  deps: { fetchImpl?: FetchImpl } = {}
): Promise<{ month: string; rows: number; more: boolean; cursorKey: string }> {
  const doFetch = deps.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const earliest = await getConfigString(env, "FCC_AGG_EARLIEST", EARLIEST_DEFAULT);

  const cur = await env.CONFIG.get("cursor:fcc_agg_month");
  const month = cur ?? earliest;
  const now = currentMonth();
  if (month > now) {
    return { month, rows: 0, more: false, cursorKey: month };
  }

  const headers: Record<string, string> = { "User-Agent": "carriers-on-notice/0.1 (+contact@athipp.com)", Accept: "application/json" };
  const token = await getConfigString(env, "SOCRATA_APP_TOKEN_PUBLIC", "");
  if (token) headers["X-App-Token"] = token;

  const start = monthStartISO(month);
  const end = monthEndISO(month);
  const rows: FccAggRow[] = [];

  // State-level.
  try {
    const res = await doFetch(buildFccAggQuery(BASE, "state", start, end, 100), { headers });
    if (res.ok) {
      const data = (await res.json()) as Array<{ state?: string; month?: string; count?: string }>;
      for (const r of data) {
        if (!r.state) continue;
        rows.push({ month: toMonthKey(r.month, month), state: r.state, zip: null, method: null, count: Number(r.count ?? 0) });
      }
    }
  } catch {
    // leave state rows empty for this run
  }

  // Zip-level, top ZIP_LIMIT by count.
  try {
    const res = await doFetch(buildFccAggQuery(BASE, "zip", start, end, ZIP_LIMIT), { headers });
    if (res.ok) {
      const data = (await res.json()) as Array<{ zip?: string; month?: string; count?: string }>;
      for (const r of data) {
        if (!r.zip) continue;
        rows.push({ month: toMonthKey(r.month, month), state: null, zip: r.zip, method: null, count: Number(r.count ?? 0) });
      }
    }
  } catch {
    // leave zip rows empty for this run
  }

  const inserted = await insertFccMonthly(env, rows);

  const next = addMonths(month, 1);
  await env.CONFIG.put("cursor:fcc_agg_month", next);
  const more = next <= now;
  return { month, rows: inserted, more, cursorKey: next };
}
