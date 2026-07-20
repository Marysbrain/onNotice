import type { Env } from "../env.js";
import { enabledSources, insertRecord, touchSource } from "../db/records.js";

// FCC consumer complaint dataset via Socrata (SODA). Incremental by
// ticket_created. These rows feed the map aggregates. There is NO carrier field
// in this dataset, so carrier stays null and vetting_status stays single_source.
// We never present these as per-carrier counts.
//
// Optional app token (secret SOCRATA_APP_TOKEN) raises the throttle. Works
// without one. We pull a small page per run and let the cron cadence walk the
// history, which keeps us inside the D1 per-invocation query cap and the CPU
// budget.

const MAX_ROWS_PER_RUN = 25;

export interface SocrataRow {
  ticket_created?: string;
  issue_type?: string;
  issue?: string;
  city?: string;
  state?: string;
  zip?: string;
  method_of_contact?: string;
  method?: string;
  id?: string;
  [k: string]: unknown;
}

// Build the SODA query URL. Everything goes in $where so we can combine the
// Phone filter and the incremental cursor. Ordered by ticket_created ascending
// so pagination and the cursor advance are stable.
export function buildSocrataQuery(baseUrl: string, cursor: string | null, limit: number, offset: number): string {
  const where = cursor
    ? `issue_type='Phone' AND ticket_created > '${cursor}'`
    : `issue_type='Phone'`;
  const params = new URLSearchParams({
    $where: where,
    $order: "ticket_created ASC",
    $limit: String(limit),
    $offset: String(offset),
  });
  return `${baseUrl}?${params.toString()}`;
}

// The new cursor is the max ticket_created seen, or the previous cursor if the
// page was empty.
export function nextCursor(rows: SocrataRow[], prev: string | null): string | null {
  let max = prev;
  for (const r of rows) {
    const t = r.ticket_created;
    if (t && (!max || t > max)) max = t;
  }
  return max;
}

export function socrataDedupeKey(row: SocrataRow): string {
  const id = row.id ?? (row[":id"] as string | undefined);
  if (id) return `socrata:${id}`;
  return `socrata:${row.ticket_created ?? ""}:${row.city ?? ""}:${row.state ?? ""}:${row.zip ?? ""}`;
}

export async function collectSocrata(env: Env): Promise<{ source: string; new: number }[]> {
  const sources = await enabledSources(env, "socrata");
  const out: { source: string; new: number }[] = [];
  const headers: Record<string, string> = {
    "User-Agent": "carriers-on-notice/0.1 (+contact@athipp.com)",
    Accept: "application/json",
  };
  if (env.SOCRATA_APP_TOKEN) headers["X-App-Token"] = env.SOCRATA_APP_TOKEN;

  for (const src of sources) {
    if (!src.url) continue;
    const cursor = src.cursor || null;
    let added = 0;
    try {
      const url = buildSocrataQuery(src.url, cursor, MAX_ROWS_PER_RUN, 0);
      const res = await fetch(url, { headers });
      if (!res.ok) {
        out.push({ source: src.id, new: 0 });
        continue;
      }
      const rows = (await res.json()) as SocrataRow[];
      const capture = Math.floor(Date.now() / 1000);

      for (const row of rows) {
        const issue = row.issue_type ?? row.issue ?? "Phone";
        const method = row.method_of_contact ?? row.method ?? "";
        const city = row.city ?? null;
        const state = row.state ?? null;
        const zip = row.zip ?? null;
        const excerpt = `FCC consumer complaint | issue=${issue} | method=${method} | ${[city, state, zip].filter(Boolean).join(" ")}`.slice(0, 500);
        const inserted = await insertRecord(env, {
          dedupeKey: socrataDedupeKey(row),
          sourceId: src.id,
          sourceUrl: src.url,
          captureDate: capture,
          recordDate: row.ticket_created ? Math.floor(Date.parse(row.ticket_created) / 1000) : null,
          excerpt,
          // No carrier field in this dataset. Stays null. Never per-carrier.
          carrier: null,
          allegedIssue: String(issue),
          locCity: city,
          locState: state,
          locZip: zip,
          vettingStatus: "single_source",
        });
        if (inserted) added++;
      }

      await touchSource(env, src.id, nextCursor(rows, cursor) ?? "");
    } catch {
      // Drop this run. Cursor unchanged.
    }
    out.push({ source: src.id, new: added });
  }
  return out;
}
