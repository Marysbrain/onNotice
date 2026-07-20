import type { Env } from "../env.js";

// Corroboration. Upgrade vetting_status from single_source to corroborated when
// independent sources agree: the same carrier plus the same alleged_issue (or the
// same promo_name) reported by two or more DIFFERENT source_ids within a 90 day
// window.
//
// verified_primary is never set here. Only a human marks a record verified_primary.
//
// One wide SELECT (1 query) feeds in-memory grouping; upgrades are bulk IN
// updates (1 to 2 queries), so a sweep is a handful of D1 queries.

const WINDOW_SECONDS = 90 * 24 * 60 * 60;
const SCAN_LIMIT = 300;
const IN_CHUNK = 90;

interface Cand {
  id: number;
  carrier: string;
  alleged_issue: string | null;
  promo_name: string | null;
  source_id: string | null;
  ts: number;
}

// Given entries in one group, does any 90 day window hold two different sources?
export function windowHasTwoSources(entries: Array<{ source_id: string | null; ts: number }>): boolean {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  for (let i = 0; i < sorted.length; i++) {
    const seen = new Set<string>();
    for (let j = i; j < sorted.length; j++) {
      if (sorted[j]!.ts - sorted[i]!.ts > WINDOW_SECONDS) break;
      seen.add(sorted[j]!.source_id ?? "");
      if (seen.size >= 2) return true;
    }
  }
  return false;
}

export async function runCorroborate(env: Env): Promise<{ scanned: number; upgraded: number }> {
  const res = await env.DB.prepare(
    `SELECT id, carrier, alleged_issue, promo_name, source_id,
            COALESCE(record_date, capture_date) AS ts
       FROM records
      WHERE vetting_status = 'single_source'
        AND carrier IS NOT NULL
        AND (alleged_issue IS NOT NULL OR promo_name IS NOT NULL)
      ORDER BY id
      LIMIT ?1`
  )
    .bind(SCAN_LIMIT)
    .all<Cand>();

  const rows = res.results ?? [];
  // Group by carrier+issue and carrier+promo. A record can be in both.
  const groups = new Map<string, Cand[]>();
  const add = (key: string, row: Cand) => {
    const g = groups.get(key);
    if (g) g.push(row);
    else groups.set(key, [row]);
  };
  for (const r of rows) {
    if (r.alleged_issue) add(`i|${r.carrier}|${r.alleged_issue}`, r);
    if (r.promo_name) add(`p|${r.carrier}|${r.promo_name}`, r);
  }

  const upgrade = new Set<number>();
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    if (windowHasTwoSources(entries)) {
      for (const e of entries) upgrade.add(e.id);
    }
  }

  const ids = [...upgrade];
  let upgraded = 0;
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const group = ids.slice(i, i + IN_CHUNK);
    if (group.length === 0) continue;
    const placeholders = group.map((_, k) => `?${k + 2}`).join(",");
    const out = await env.DB.prepare(
      `UPDATE records SET vetting_status = 'corroborated', updated_at = ?1
        WHERE vetting_status = 'single_source' AND id IN (${placeholders})`
    )
      .bind(now, ...group)
      .run();
    upgraded += out.meta.changes ?? 0;
  }

  return { scanned: rows.length, upgraded };
}
