import type { Env } from "../env.js";

// Shared DB helpers for the social listeners and their purge jobs.
//
// Purge writes are kept cheap: instead of one DELETE/UPDATE per record, we bulk
// them with IN lists. D1's bound-parameter cap is 100 per query, so we chunk IN
// lists at 90 to stay clear. That keeps a whole purge sweep to a couple of D1
// writes regardless of batch size, well under the 50-queries-per-invocation cap.

const IN_CHUNK = 90;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface DueRow {
  dedupe_key: string;
  source_id: string | null;
}

// Records of the given sources, oldest-checked first. A null last_checked_at
// sorts first (COALESCE to 0), so freshly inserted rows get verified soon.
export async function dueForRecheck(env: Env, sourceIds: string[], limit: number): Promise<DueRow[]> {
  if (sourceIds.length === 0) return [];
  const placeholders = sourceIds.map((_, i) => `?${i + 1}`).join(",");
  const res = await env.DB.prepare(
    `SELECT dedupe_key, source_id FROM records
      WHERE source_id IN (${placeholders})
      ORDER BY COALESCE(last_checked_at, 0) ASC
      LIMIT ?${sourceIds.length + 1}`
  )
    .bind(...sourceIds, limit)
    .all<DueRow>();
  return res.results ?? [];
}

// Hard-delete records by dedupe key. Purged means gone from D1, not flagged.
export async function purgeKeys(env: Env, keys: string[]): Promise<number> {
  let deleted = 0;
  for (const group of chunk(keys, IN_CHUNK)) {
    if (group.length === 0) continue;
    const placeholders = group.map((_, i) => `?${i + 1}`).join(",");
    const res = await env.DB.prepare(`DELETE FROM records WHERE dedupe_key IN (${placeholders})`)
      .bind(...group)
      .run();
    deleted += res.meta.changes ?? 0;
  }
  return deleted;
}

// Mark records verified-present at ts. Survivors of a purge sweep get this so
// they rotate to the back of the recheck queue.
export async function markChecked(env: Env, keys: string[], ts: number): Promise<void> {
  for (const group of chunk(keys, IN_CHUNK)) {
    if (group.length === 0) continue;
    const placeholders = group.map((_, i) => `?${i + 2}`).join(",");
    await env.DB.prepare(`UPDATE records SET last_checked_at = ?1 WHERE dedupe_key IN (${placeholders})`)
      .bind(ts, ...group)
      .run();
  }
}
