import type { Env } from "../env.js";
import { getCarrierMentionsMonthly } from "../db/aggregates.js";

// Publish pre-aggregated JSON to R2 for Track E. The public site reads these
// files directly, so they carry counts and locations only. No excerpts, no
// author data, nothing from a social record body.
//
// Deterministic file names, overwritten each run:
//   aggregates/map.json      counts by state and by zip
//   aggregates/mentions.json monthly carrier mentions
//   aggregates/totals.json   totals, including the strict verified count
//
// The map layer counts only rows that are cleared or better (review_status =
// cleared), from location-bearing sources (FCC Socrata and story submissions).
// The verified count in totals is strict: corroborated or verified_primary only.

export interface MapAggregate {
  generated_at: number;
  byState: Array<{ state: string; count: number }>;
  byZip: Array<{ zip: string; count: number }>;
}

export interface TotalsAggregate {
  generated_at: number;
  records: number;
  verified: number; // corroborated + verified_primary only
  byVetting: Record<string, number>;
}

export async function buildMap(env: Env): Promise<MapAggregate> {
  const byState = await env.DB.prepare(
    `SELECT loc_state AS state, COUNT(*) AS count
       FROM records
      WHERE review_status = 'cleared'
        AND loc_state IS NOT NULL
        AND (source_id = 'fcc_socrata' OR source_id LIKE 'story%')
      GROUP BY loc_state
      ORDER BY count DESC`
  ).all<{ state: string; count: number }>();

  const byZip = await env.DB.prepare(
    `SELECT loc_zip AS zip, COUNT(*) AS count
       FROM records
      WHERE review_status = 'cleared'
        AND loc_zip IS NOT NULL
        AND (source_id = 'fcc_socrata' OR source_id LIKE 'story%')
      GROUP BY loc_zip
      ORDER BY count DESC`
  ).all<{ zip: string; count: number }>();

  return {
    generated_at: Math.floor(Date.now() / 1000),
    byState: byState.results ?? [],
    byZip: byZip.results ?? [],
  };
}

export async function buildTotals(env: Env): Promise<TotalsAggregate> {
  const rows = await env.DB.prepare(
    `SELECT vetting_status AS v, COUNT(*) AS count FROM records GROUP BY vetting_status`
  ).all<{ v: string; count: number }>();

  const byVetting: Record<string, number> = {};
  let records = 0;
  let verified = 0;
  for (const r of rows.results ?? []) {
    byVetting[r.v] = r.count;
    records += r.count;
    if (r.v === "corroborated" || r.v === "verified_primary") verified += r.count;
  }

  return { generated_at: Math.floor(Date.now() / 1000), records, verified, byVetting };
}

export async function runPublish(env: Env): Promise<{ map: number; mentions: number; totals: number }> {
  const map = await buildMap(env);
  const mentions = await getCarrierMentionsMonthly(env);
  const totals = await buildTotals(env);

  const mentionsDoc = { generated_at: Math.floor(Date.now() / 1000), rows: mentions };

  await env.RAW.put("aggregates/map.json", JSON.stringify(map), {
    httpMetadata: { contentType: "application/json" },
  });
  await env.RAW.put("aggregates/mentions.json", JSON.stringify(mentionsDoc), {
    httpMetadata: { contentType: "application/json" },
  });
  await env.RAW.put("aggregates/totals.json", JSON.stringify(totals), {
    httpMetadata: { contentType: "application/json" },
  });

  return { map: map.byState.length + map.byZip.length, mentions: mentions.length, totals: totals.records };
}
