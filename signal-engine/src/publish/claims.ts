import type { Env } from "../env.js";
import { getCursor, setCursor } from "../lib/config.js";
import {
  parseColumnCents,
  CLAIM_CONSUMER_KEYS,
  AWARD_CONSUMER_KEYS,
} from "../ask/money.js";

// Arbitration dollar aggregation, written to R2 as aggregates/claims.json.
//
// The excerpts of aaa_arb records carry dollar columns ("claim amt consumer=",
// "award amt consumer=") but they are TRUNCATED at 500 chars, so some rows lose
// their dollar cells. Regex parsing of those cells cannot run in SQL, so it runs
// here in the Worker. There are ~9,300 aaa_arb rows and the free plan caps CPU
// per invocation, so a single run cannot parse them all. Instead each publish
// run processes one bounded batch and accumulates into arb_claim_rollup; when a
// sweep reaches the end, the rollup is copied to arb_claim_published and reset.
// claims.json is always built from arb_claim_published, i.e. the last COMPLETED
// sweep, so the public numbers never show a mid-sweep partial total.
//
// CADENCE MATH: publish is enqueued once per hour (src/index.ts dedupes the
// publish job by hour bucket). With BATCH = 300, one sweep of ~9,300 eligible
// aaa_arb rows takes ceil(9300 / 300) = 31 runs, i.e. about 31 hours, so the
// published dollar totals refresh a little over once a day. Each run issues well
// under 10 D1 queries (one batch SELECT, at most a few per-carrier upserts, and
// on completion three table-copy statements), far under the 50-query ceiling.
// Raising BATCH shortens the sweep but costs more CPU per run; 300 keeps a run
// cheap while completing inside a day.

const BATCH = 300;

// Same eligibility clause as src/ask/answer.ts (RULE 4). Do not loosen.
const ELIGIBLE = `review_status = 'cleared' AND vetting_status IN ('corroborated','verified_primary')`;

const CURSOR_KEY = "publish_claims_id";
const GENERATED_AT_KEY = "publish_claims_at";

interface Tally {
  cases: number;
  claimCents: number;
  claimRows: number;
  awardCents: number;
  awardRows: number;
}

function emptyTally(): Tally {
  return { cases: 0, claimCents: 0, claimRows: 0, awardCents: 0, awardRows: 0 };
}

export interface ClaimCarrierRow {
  carrier: string;
  cases: number;
  claim_consumer_total_cents: number;
  claim_consumer_parsed_rows: number;
  award_consumer_total_cents: number;
  award_consumer_parsed_rows: number;
}

export interface ClaimsAggregate {
  generated_at: number;
  source: "aaa_arb excerpts";
  coverage_note: string;
  byCarrier: ClaimCarrierRow[];
  total_claim_consumer_cents: number;
  total_rows: number;
}

const COVERAGE_NOTE =
  "These counts come from the AAA consumer arbitration public file; dollar figures are parsed conservatively from case excerpts truncated at 500 characters, and rows whose amounts could not be parsed are excluded, so totals are lower bounds.";

// Advance the in-progress sweep by one batch. Returns whether this run completed
// a full sweep (and therefore refreshed arb_claim_published). Exposed with a
// configurable batch size so tests can drive it in small steps.
export async function advanceClaims(
  env: Env,
  batchSize: number = BATCH
): Promise<{ processed: number; completed: boolean }> {
  const cursor = await getCursor(env, CURSOR_KEY, 0);

  const res = await env.DB.prepare(
    `SELECT id, carrier, excerpt
       FROM records
      WHERE ${ELIGIBLE}
        AND source_id = 'aaa_arb'
        AND carrier IS NOT NULL
        AND id > ?1
      ORDER BY id ASC
      LIMIT ?2`
  )
    .bind(cursor, batchSize)
    .all<{ id: number; carrier: string; excerpt: string }>();

  const rows = res.results ?? [];

  // Tally this batch in memory, one entry per carrier, so we touch each carrier
  // row in D1 at most once regardless of batch size.
  const tallies = new Map<string, Tally>();
  let maxId = cursor;
  for (const r of rows) {
    if (r.id > maxId) maxId = r.id;
    let t = tallies.get(r.carrier);
    if (!t) {
      t = emptyTally();
      tallies.set(r.carrier, t);
    }
    t.cases += 1;

    const claim = parseColumnCents(r.excerpt, CLAIM_CONSUMER_KEYS);
    if (claim !== null) {
      t.claimCents += claim;
      t.claimRows += 1;
    }
    const award = parseColumnCents(r.excerpt, AWARD_CONSUMER_KEYS);
    if (award !== null) {
      t.awardCents += award;
      t.awardRows += 1;
    }
  }

  // Fold this batch into the rollup (add to any existing running sums).
  for (const [carrier, t] of tallies) {
    await env.DB.prepare(
      `INSERT INTO arb_claim_rollup
         (carrier, cases, claim_consumer_total_cents, claim_consumer_parsed_rows,
          award_consumer_total_cents, award_consumer_parsed_rows)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(carrier) DO UPDATE SET
         cases = cases + excluded.cases,
         claim_consumer_total_cents = claim_consumer_total_cents + excluded.claim_consumer_total_cents,
         claim_consumer_parsed_rows = claim_consumer_parsed_rows + excluded.claim_consumer_parsed_rows,
         award_consumer_total_cents = award_consumer_total_cents + excluded.award_consumer_total_cents,
         award_consumer_parsed_rows = award_consumer_parsed_rows + excluded.award_consumer_parsed_rows`
    )
      .bind(carrier, t.cases, t.claimCents, t.claimRows, t.awardCents, t.awardRows)
      .run();
  }

  // A short batch means we reached the end of the eligible set: finalize the
  // sweep. Copy rollup to published, clear the rollup, reset the cursor, and
  // stamp the completion time so claims.json reports when the numbers are from.
  const completed = rows.length < batchSize;
  if (completed) {
    await env.DB.prepare(`DELETE FROM arb_claim_published`).run();
    await env.DB.prepare(
      `INSERT INTO arb_claim_published
         (carrier, cases, claim_consumer_total_cents, claim_consumer_parsed_rows,
          award_consumer_total_cents, award_consumer_parsed_rows)
       SELECT carrier, cases, claim_consumer_total_cents, claim_consumer_parsed_rows,
              award_consumer_total_cents, award_consumer_parsed_rows
         FROM arb_claim_rollup`
    ).run();
    await env.DB.prepare(`DELETE FROM arb_claim_rollup`).run();
    await setCursor(env, CURSOR_KEY, 0);
    await setCursor(env, GENERATED_AT_KEY, Math.floor(Date.now() / 1000));
  } else {
    await setCursor(env, CURSOR_KEY, maxId);
  }

  return { processed: rows.length, completed };
}

// Build the claims.json document from the last completed sweep. Before the first
// sweep finishes, arb_claim_published is empty and this returns an honest empty
// aggregate (generated_at 0, no carriers, zero totals) rather than partial data.
export async function buildClaimsAggregate(env: Env): Promise<ClaimsAggregate> {
  const res = await env.DB.prepare(
    `SELECT carrier, cases, claim_consumer_total_cents, claim_consumer_parsed_rows,
            award_consumer_total_cents, award_consumer_parsed_rows
       FROM arb_claim_published
      ORDER BY claim_consumer_total_cents DESC, carrier ASC`
  ).all<ClaimCarrierRow>();

  const byCarrier = res.results ?? [];
  let totalClaimCents = 0;
  let totalRows = 0;
  for (const r of byCarrier) {
    totalClaimCents += r.claim_consumer_total_cents;
    totalRows += r.cases;
  }

  const generatedAt = await getCursor(env, GENERATED_AT_KEY, 0);

  return {
    generated_at: generatedAt,
    source: "aaa_arb excerpts",
    coverage_note: COVERAGE_NOTE,
    byCarrier,
    total_claim_consumer_cents: totalClaimCents,
    total_rows: totalRows,
  };
}

// One published-carrier row, for the /ask count sentence. Null when the last
// completed sweep has no parsed consumer claim dollars for that carrier.
export async function claimTotalForCarrier(
  env: Env,
  carrier: string
): Promise<{ cents: number; parsedRows: number } | null> {
  const row = await env.DB.prepare(
    `SELECT claim_consumer_total_cents AS cents, claim_consumer_parsed_rows AS rows
       FROM arb_claim_published
      WHERE carrier = ?1`
  )
    .bind(carrier)
    .first<{ cents: number; rows: number }>();

  if (!row || row.cents <= 0 || row.rows <= 0) return null;
  return { cents: row.cents, parsedRows: row.rows };
}
