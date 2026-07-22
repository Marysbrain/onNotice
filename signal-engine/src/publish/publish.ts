import type { Env } from "../env.js";
import { getCarrierMentionsMonthly } from "../db/aggregates.js";
import { sumByState, sumByZip, monthlyTrendByState, monthRange } from "../db/fcc.js";
import { computeHotspots } from "./hotspots.js";
import { getCursor, setCursor } from "../lib/config.js";
import { blueskyPermalink } from "../collectors/bluesky.js";
import { advanceClaims, buildClaimsAggregate } from "./claims.js";

// Publish pre-aggregated JSON to R2 for Track E. The public site reads these
// files directly, so they carry counts and locations only. No excerpts, no
// author data, nothing from a social record body.
//
// Core files (written every run):
//   aggregates/map.json       counts by state and by zip (from FCC monthly aggregates)
//   aggregates/mentions.json  monthly carrier mentions view
//   aggregates/totals.json    totals, including the strict verified count
//   aggregates/hotspots.json  ranked hot spots for the map flames
//   aggregates/links.json     the thread graph (cleared-or-better records only)
//   aggregates/claims.json    arbitration consumer claim/award dollar totals from
//                             the last completed aaa_arb excerpt sweep
//
// Rabbit-hole drill-down (spread across runs by cursor):
//   aggregates/states/{XX}.json   per-state monthly trend, top issues, records
//   aggregates/records/{id}.json  per-record citation block
//
// PRIVACY: only records that are cleared AND corroborated-or-better are exposed
// in the per-state records list, per-record files, and the link graph. Excerpts
// are never included. A Bluesky source_url is converted to its derived permalink
// so no raw AT-URI is published beyond what Track E would show.

const STATES_PER_RUN = 3;
const RECORDS_PER_RUN = 6;

const JSON_META = { httpMetadata: { contentType: "application/json" } };

// Records eligible for public display.
const DISPLAY_WHERE = `review_status = 'cleared' AND vetting_status IN ('corroborated','verified_primary')`;

function publicSourceUrl(sourceId: string | null, sourceUrl: string): string {
  if (sourceId === "bluesky" && sourceUrl.startsWith("at://")) {
    return blueskyPermalink(sourceUrl) ?? sourceUrl;
  }
  return sourceUrl;
}

export interface MapAggregate {
  generated_at: number;
  source: string;
  // The month span the counts cover, so the site can label a partial backfill
  // honestly. Null until the first FCC aggregate lands.
  coverage: { from: string; to: string } | null;
  byState: Array<{ state: string; count: number }>;
  byZip: Array<{ zip: string; count: number }>;
}

export interface TotalsAggregate {
  generated_at: number;
  records: number;
  verified: number; // corroborated + verified_primary only
  byVetting: Record<string, number>;
}

// Map from the FCC monthly aggregates table. FCC has no carrier field, so this
// is complaint concentration by place, not per-carrier counts.
export async function buildMap(env: Env): Promise<MapAggregate> {
  return {
    generated_at: Math.floor(Date.now() / 1000),
    source: "fcc_monthly_aggregates",
    coverage: await monthRange(env),
    byState: await sumByState(env),
    byZip: await sumByZip(env, 1000),
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

// Thread graph: nodes are displayable record ids, edges are links whose both
// endpoints are displayable.
export async function buildLinksGraph(env: Env): Promise<{ generated_at: number; nodes: number[]; edges: Array<{ a: number; b: number; link_type: string; basis: string }> }> {
  const nodeRows = await env.DB.prepare(`SELECT id FROM records WHERE ${DISPLAY_WHERE}`).all<{ id: number }>();
  const nodes = (nodeRows.results ?? []).map((r) => r.id);
  const nodeSet = new Set(nodes);

  const linkRows = await env.DB.prepare(
    `SELECT record_id_a AS a, record_id_b AS b, link_type, basis FROM links`
  ).all<{ a: number; b: number; link_type: string; basis: string }>();
  const edges = (linkRows.results ?? []).filter((e) => nodeSet.has(e.a) && nodeSet.has(e.b));

  return { generated_at: Math.floor(Date.now() / 1000), nodes, edges };
}

interface DisplayRecord {
  id: number;
  carrier: string | null;
  promo_name: string | null;
  alleged_issue: string | null;
  loc_state: string | null;
  loc_zip: string | null;
  record_date: number | null;
  capture_date: number;
  source_id: string | null;
  source_url: string;
  vetting_status: string;
  confidence: number | null;
}

// The public citation block for one record. No excerpt.
function citation(r: DisplayRecord) {
  return {
    id: r.id,
    carrier: r.carrier,
    promo_name: r.promo_name,
    claim: r.alleged_issue,
    location: { state: r.loc_state, zip: r.loc_zip },
    record_date: r.record_date,
    capture_date: r.capture_date,
    source_url: publicSourceUrl(r.source_id, r.source_url),
    vetting_status: r.vetting_status,
    confidence: r.confidence,
  };
}

async function writeStateFiles(env: Env): Promise<number> {
  // Stable ordered state list from the FCC aggregates.
  const states = (await sumByState(env)).map((s) => s.state);
  if (states.length === 0) return 0;

  const startRaw = await getCursor(env, "publish_state_idx", 0);
  const start = startRaw % states.length;
  let written = 0;

  for (let i = 0; i < STATES_PER_RUN && i < states.length; i++) {
    const state = states[(start + i) % states.length]!;
    const trend = await monthlyTrendByState(env, state);

    const issues = await env.DB.prepare(
      `SELECT alleged_issue AS issue, COUNT(*) AS count FROM records
        WHERE ${DISPLAY_WHERE} AND loc_state = ?1 AND alleged_issue IS NOT NULL
        GROUP BY alleged_issue ORDER BY count DESC LIMIT 10`
    )
      .bind(state)
      .all<{ issue: string; count: number }>();

    const recs = await env.DB.prepare(
      `SELECT id, carrier, promo_name, alleged_issue, loc_state, loc_zip, record_date, capture_date,
              source_id, source_url, vetting_status, confidence
         FROM records
        WHERE ${DISPLAY_WHERE} AND loc_state = ?1
        ORDER BY record_date DESC LIMIT 100`
    )
      .bind(state)
      .all<DisplayRecord>();

    const doc = {
      generated_at: Math.floor(Date.now() / 1000),
      state,
      monthly_trend: trend,
      top_issues: issues.results ?? [],
      records: (recs.results ?? []).map(citation),
    };
    await env.RAW.put(`aggregates/states/${state}.json`, JSON.stringify(doc), JSON_META);
    written++;
  }

  await setCursor(env, "publish_state_idx", (start + STATES_PER_RUN) % states.length);
  return written;
}

async function writeRecordFiles(env: Env): Promise<number> {
  const start = await getCursor(env, "publish_record_id", 0);
  const rows = await env.DB.prepare(
    `SELECT id, carrier, promo_name, alleged_issue, loc_state, loc_zip, record_date, capture_date,
            source_id, source_url, vetting_status, confidence
       FROM records
      WHERE ${DISPLAY_WHERE} AND id > ?1
      ORDER BY id ASC LIMIT ?2`
  )
    .bind(start, RECORDS_PER_RUN)
    .all<DisplayRecord>();

  const list = rows.results ?? [];
  let written = 0;
  let maxId = start;
  for (const r of list) {
    await env.RAW.put(`aggregates/records/${r.id}.json`, JSON.stringify(citation(r)), JSON_META);
    written++;
    maxId = r.id;
  }
  // Wrap to the start when we run out, so the set refreshes over time.
  await setCursor(env, "publish_record_id", list.length < RECORDS_PER_RUN ? 0 : maxId);
  return written;
}

export async function runPublish(
  env: Env
): Promise<{ map: number; mentions: number; totals: number; states: number; records: number; hotspots: number; edges: number; claims_processed: number; claims_completed: boolean }> {
  const now = Math.floor(Date.now() / 1000);

  const map = await buildMap(env);
  const mentions = await getCarrierMentionsMonthly(env);
  const totals = await buildTotals(env);
  const hotspots = await computeHotspots(env, 10);
  const graph = await buildLinksGraph(env);

  await env.RAW.put("aggregates/map.json", JSON.stringify(map), JSON_META);
  await env.RAW.put("aggregates/mentions.json", JSON.stringify({ generated_at: now, rows: mentions }), JSON_META);
  await env.RAW.put("aggregates/totals.json", JSON.stringify(totals), JSON_META);
  await env.RAW.put("aggregates/hotspots.json", JSON.stringify({ generated_at: now, hotspots }), JSON_META);
  await env.RAW.put("aggregates/links.json", JSON.stringify(graph), JSON_META);

  const states = await writeStateFiles(env);
  const records = await writeRecordFiles(env);

  // Advance the arbitration-dollar sweep by one bounded batch, then publish the
  // last completed sweep. The write happens every run so the file always exists;
  // its contents only change when a sweep finishes (see claims.ts).
  const claims = await advanceClaims(env);
  const claimsDoc = await buildClaimsAggregate(env);
  await env.RAW.put("aggregates/claims.json", JSON.stringify(claimsDoc), JSON_META);

  return {
    map: map.byState.length + map.byZip.length,
    mentions: mentions.length,
    totals: totals.records,
    states,
    records,
    hotspots: hotspots.length,
    edges: graph.edges.length,
    claims_processed: claims.processed,
    claims_completed: claims.completed,
  };
}
