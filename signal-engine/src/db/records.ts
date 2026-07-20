import type { Env } from "../env.js";

// A record insert. Collectors fill source fields and excerpt. Track C fields are
// left null here and set later by the classifier. Location is city/state/zip
// only. Never a full address, never a person.
export interface RecordInput {
  dedupeKey: string;
  sourceId: string;
  sourceUrl: string;
  captureDate: number; // unix seconds
  recordDate?: number | null;
  excerpt: string;
  archiveUrl?: string | null;
  carrier?: string | null;
  promoName?: string | null;
  allegedIssue?: string | null;
  locCity?: string | null;
  locState?: string | null;
  locZip?: string | null;
  vettingStatus?: "verified_primary" | "corroborated" | "single_source" | "disputed";
  rawRef?: string | null;
}

// Insert one record. Idempotent on dedupe_key via the unique index, so re-runs
// do not duplicate. Returns true if a new row was inserted.
export async function insertRecord(env: Env, r: RecordInput): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO records
       (dedupe_key, source_id, source_url, capture_date, record_date, excerpt,
        archive_url, carrier, promo_name, alleged_issue, loc_city, loc_state,
        loc_zip, vetting_status, raw_ref)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`
  )
    .bind(
      r.dedupeKey,
      r.sourceId,
      r.sourceUrl,
      r.captureDate,
      r.recordDate ?? null,
      r.excerpt,
      r.archiveUrl ?? null,
      r.carrier ?? null,
      r.promoName ?? null,
      r.allegedIssue ?? null,
      r.locCity ?? null,
      r.locState ?? null,
      r.locZip ?? null,
      r.vettingStatus ?? "single_source",
      r.rawRef ?? null
    )
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export interface SourceRow {
  id: string;
  kind: string;
  display: string;
  url: string | null;
  enabled: number;
  cursor: string | null;
  rate_limit_ms: number;
}

// Enabled sources of a kind. Collectors read their targets from here.
export async function enabledSources(env: Env, kind: string): Promise<SourceRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, kind, display, url, enabled, cursor, rate_limit_ms
       FROM sources WHERE kind = ?1 AND enabled = 1`
  )
    .bind(kind)
    .all<SourceRow>();
  return res.results ?? [];
}

export async function touchSource(env: Env, id: string, cursor?: string): Promise<void> {
  const t = Math.floor(Date.now() / 1000);
  if (cursor === undefined) {
    await env.DB.prepare(`UPDATE sources SET last_run_at = ?2 WHERE id = ?1`).bind(id, t).run();
  } else {
    await env.DB.prepare(`UPDATE sources SET last_run_at = ?2, cursor = ?3 WHERE id = ?1`)
      .bind(id, t, cursor)
      .run();
  }
}
