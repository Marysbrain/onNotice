import type { Env } from "../env.js";
import { getCursor, setCursor } from "../lib/config.js";
import {
  parseColumnCents,
  CLAIM_CONSUMER_KEYS,
  AWARD_CONSUMER_KEYS,
} from "../ask/money.js";

// Robust arbitration dollar aggregation, written to R2 as aggregates/claims.json.
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
// WHY ROBUST STATS (RULE 1, real numbers in impression as well as arithmetic):
// the faithful raw claim sum is dominated by absurd outlier asks. The first sweep
// produced a Verizon consumer-claim column sum of 59.6 billion dollars across
// 3,178 phone disputes, against awards that average about 1,400 dollars. A number
// that is arithmetically correct but reads as a lie is not shippable. So per
// carrier we also accumulate:
//   * claim_capped_total_cents / claim_capped_rows: the sum and count of claims
//     at or under the cap (CLAIM_CAP_CENTS = $25,000). One outlier can no longer
//     move this total by more than the cap.
//   * claims_above_cap: how many filings asked MORE than the cap. Counted, never
//     summed. This is where the billion-dollar asks land, and nowhere else.
//   * a fixed power-of-two cent histogram (hb00..hb22) over the capped claims,
//     from which we derive an APPROXIMATE median (see histMedianCents). The
//     median is inherently robust and gives the "typical claim" figure.
// The old raw sums are kept (renamed raw_*) for audit but are never published as
// a headline figure.
//
// CADENCE MATH: publish is enqueued once per hour (src/index.ts dedupes the
// publish job by hour bucket). With BATCH = 300, one sweep of ~9,300 eligible
// aaa_arb rows takes ceil(9300 / 300) = 31 runs, i.e. about 31 hours, so the
// published dollar totals refresh a little over once a day. Each run issues well
// under 10 D1 queries (one batch SELECT, at most a few per-carrier upserts, and
// on completion three table-copy statements), far under the 50-query ceiling.
// Raising BATCH shortens the sweep but costs more CPU per run; 300 keeps a run
// cheap while completing inside a day. TRIGGERING A FULL PASS: nothing manual is
// needed. The existing hourly publish advances the sweep one batch at a time; a
// complete fresh pass is 31 of those runs. On a schema/methodology change the
// SWEEP_GENERATION guard below restarts the sweep automatically (see below).

const BATCH = 300;

// The claim ceiling. Only claims at or under this are summed; anything larger is
// counted in claims_above_cap and never summed. $25,000 is where small-claims and
// consumer arbitration matters realistically sit; asks above it are almost always
// headline numbers, not recoveries. This exact value is stated in every published
// methodology note. In cents so all arithmetic stays integer.
export const CLAIM_CAP_CENTS = 2_500_000; // $25,000.00

// Fixed power-of-two cent buckets covering [0, CLAIM_CAP_CENTS]. Bucket 0 holds
// exactly-zero claims; bucket k (1..22) holds cents in [2^(k-1), 2^k). Because we
// only bucket claims at or under the cap (2,500,000 < 2^22 = 4,194,304), no capped
// claim ever exceeds bucket 22, so 23 buckets cover the whole range with no
// overflow. This is compact fixed state; no per-row data is stored.
export const HIST_BUCKETS = 23;

// Bucket index for a claim in cents. Uses Math.clz32 (an exact 32-bit integer op)
// to get floor(log2(cents)) with no floating-point error near powers of two.
export function claimBucket(cents: number): number {
  if (cents <= 0) return 0;
  const idx = 32 - Math.clz32(cents); // = floor(log2(cents)) + 1, exact for < 2^31
  return idx > HIST_BUCKETS - 1 ? HIST_BUCKETS - 1 : idx;
}

// Lower boundary (in cents) of bucket k. Bucket 0 is exactly 0; bucket k>=1 starts
// at 2^(k-1).
function bucketLo(k: number): number {
  return k <= 0 ? 0 : 2 ** (k - 1);
}

// Width (in cents) of bucket k. Bucket 0 is treated as width 1 (it holds only the
// value 0); bucket k>=1 spans [2^(k-1), 2^k), a width of 2^(k-1).
function bucketWidth(k: number): number {
  return k <= 0 ? 1 : 2 ** (k - 1);
}

// Approximate median (in cents) of the capped-claim distribution described by a
// histogram of per-bucket counts, using the standard grouped-median interpolation
// (assume the mass in the median bucket is spread uniformly). Returns null when
// the histogram is empty.
//
// ERROR BOUND: the exact median and this estimate both fall inside the same
// power-of-two bucket, so the estimate is within that bucket's width of the true
// value. For a median that lands in bucket k that width is 2^(k-1) cents, and
// since any value in bucket k is at least 2^(k-1), the estimate is always within
// a factor of two of the true median. Linear interpolation across the bucket makes
// the typical error far smaller than that worst case. The published figure is
// always labeled "approximate" and rounded to the nearest $10 in prose, never
// printed to the dollar.
export function histMedianCents(hist: number[]): number | null {
  let n = 0;
  for (const c of hist) n += c;
  if (n === 0) return null;

  const half = n / 2;
  let cum = 0;
  for (let k = 0; k < hist.length; k++) {
    const f = hist[k]!;
    if (f === 0) continue;
    if (cum + f >= half) {
      const med = bucketLo(k) + ((half - cum) / f) * bucketWidth(k);
      return Math.round(med);
    }
    cum += f;
  }
  return null; // unreachable when n > 0
}

// Same eligibility clause as src/ask/answer.ts (RULE 4). Do not loosen.
const ELIGIBLE = `review_status = 'cleared' AND vetting_status IN ('corroborated','verified_primary')`;

const CURSOR_KEY = "publish_claims_id";
const GENERATED_AT_KEY = "publish_claims_at";
const GENERATION_KEY = "publish_claims_generation";

// Bump this whenever the rollup/published schema or the published methodology
// changes. On the first run after a bump, advanceClaims wipes any in-progress and
// last-published state and restarts the sweep from record id 0, so the new stats
// populate from the beginning with no manual KV surgery. Generation 1 was the
// raw-sum schema (migration 0008); generation 2 is the robust schema (0009).
const SWEEP_GENERATION = 2;

// Histogram column names hb00..hb22, and the scalar columns, in a single ordered
// list so the INSERT, the incremental ON CONFLICT update, and the rollup->published
// copy all stay in lockstep without a hand-maintained column list.
const HB_COLS = Array.from({ length: HIST_BUCKETS }, (_, i) => `hb${String(i).padStart(2, "0")}`);
const SCALAR_COLS = [
  "cases",
  "raw_claim_consumer_total_cents",
  "raw_claim_consumer_parsed_rows",
  "raw_award_consumer_total_cents",
  "raw_award_consumer_parsed_rows",
  "claim_capped_total_cents",
  "claim_capped_rows",
  "claims_above_cap",
];
const ACC_COLS = [...SCALAR_COLS, ...HB_COLS]; // every column is additive across batches

interface Tally {
  cases: number;
  rawClaimCents: number;
  rawClaimRows: number;
  rawAwardCents: number;
  rawAwardRows: number;
  cappedCents: number;
  cappedRows: number;
  aboveCap: number;
  hist: number[]; // length HIST_BUCKETS
}

function emptyTally(): Tally {
  return {
    cases: 0,
    rawClaimCents: 0,
    rawClaimRows: 0,
    rawAwardCents: 0,
    rawAwardRows: 0,
    cappedCents: 0,
    cappedRows: 0,
    aboveCap: 0,
    hist: new Array(HIST_BUCKETS).fill(0),
  };
}

// Published methodology, attached to claims.json and echoed near every figure.
// Note the cap is stated in dollars AND cents so the file is self-describing.
const METHODOLOGY = {
  cap_cents: CLAIM_CAP_CENTS,
  median_method: "histogram approximation" as const,
  note:
    "Claim dollars are summed only for filings at or under $25,000 (2,500,000 cents). " +
    "Filings that asked for more are counted in claims_above_cap and never summed, so a single outlier ask cannot inflate a total. " +
    "The typical figure is an approximate median read from a fixed power-of-two cent histogram of the capped claims, not an exact median. " +
    "The raw_* fields are the unprocessed sums, kept for audit only and not a shippable figure.",
};

export interface ClaimCarrierRow {
  carrier: string;
  cases: number;
  // Robust, shippable figures.
  claim_capped_total_cents: number;
  claim_capped_rows: number;
  claims_above_cap: number;
  claim_median_cents_approx: number | null;
  // Raw, audit-only sums (renamed so nothing downstream ships them by mistake).
  raw_claim_consumer_total_cents: number;
  raw_claim_consumer_parsed_rows: number;
  raw_award_consumer_total_cents: number;
  raw_award_consumer_parsed_rows: number;
  methodology: typeof METHODOLOGY;
}

export interface ClaimsAggregate {
  generated_at: number;
  source: "aaa_arb excerpts";
  coverage_note: string;
  methodology: typeof METHODOLOGY;
  byCarrier: ClaimCarrierRow[];
  // Robust totals across carriers.
  total_claim_capped_cents: number;
  total_capped_rows: number;
  total_claims_above_cap: number;
  claim_median_cents_approx: number | null; // over all carriers' capped claims
  total_rows: number;
  // Raw, audit-only grand total.
  raw_total_claim_consumer_cents: number;
}

const COVERAGE_NOTE =
  "These counts come from the AAA consumer arbitration public file; dollar figures are parsed conservatively from case excerpts truncated at 500 characters, and rows whose amounts could not be parsed are excluded, so parsed counts are lower bounds. Claim dollars use robust statistics: see the methodology object.";

// Shape of a rollup/published row as read back from D1 (raw columns; the
// histogram arrives as hb00..hb22 which we fold into an array).
type StoredRow = {
  carrier: string;
  cases: number;
  raw_claim_consumer_total_cents: number;
  raw_claim_consumer_parsed_rows: number;
  raw_award_consumer_total_cents: number;
  raw_award_consumer_parsed_rows: number;
  claim_capped_total_cents: number;
  claim_capped_rows: number;
  claims_above_cap: number;
} & Record<string, number>;

function histFromRow(row: Record<string, number>): number[] {
  return HB_COLS.map((c) => row[c] ?? 0);
}

// On a schema/methodology generation bump, wipe both tables and reset the sweep so
// the new stats repopulate from record id 0. Idempotent: it fires once, then the
// stored generation matches SWEEP_GENERATION and this is a no-op. This is what
// makes the sweep restartable over already-swept data without manual surgery.
async function ensureGeneration(env: Env): Promise<void> {
  const gen = await getCursor(env, GENERATION_KEY, 0);
  if (gen === SWEEP_GENERATION) return;
  await env.DB.prepare(`DELETE FROM arb_claim_rollup`).run();
  await env.DB.prepare(`DELETE FROM arb_claim_published`).run();
  await setCursor(env, CURSOR_KEY, 0);
  await setCursor(env, GENERATED_AT_KEY, 0);
  await setCursor(env, GENERATION_KEY, SWEEP_GENERATION);
}

// Advance the in-progress sweep by one batch. Returns whether this run completed
// a full sweep (and therefore refreshed arb_claim_published). Exposed with a
// configurable batch size so tests can drive it in small steps.
export async function advanceClaims(
  env: Env,
  batchSize: number = BATCH
): Promise<{ processed: number; completed: boolean }> {
  await ensureGeneration(env);

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
      // Raw sum keeps every parsed claim, outliers included, for audit only.
      t.rawClaimCents += claim;
      t.rawClaimRows += 1;
      // Robust stats split on the cap: at/under -> sum + count + histogram;
      // over -> counted but never summed, so outliers cannot inflate a total.
      if (claim <= CLAIM_CAP_CENTS) {
        t.cappedCents += claim;
        t.cappedRows += 1;
        const b = claimBucket(claim);
        t.hist[b] = (t.hist[b] ?? 0) + 1;
      } else {
        t.aboveCap += 1;
      }
    }
    const award = parseColumnCents(r.excerpt, AWARD_CONSUMER_KEYS);
    if (award !== null) {
      t.rawAwardCents += award;
      t.rawAwardRows += 1;
    }
  }

  // Build the incremental upsert once. Every column in ACC_COLS is additive, so
  // ON CONFLICT folds the batch delta into the running rollup in one atomic
  // statement per carrier, exactly as the original raw-sum sweep did.
  const insertCols = ["carrier", ...ACC_COLS];
  const placeholders = insertCols.map((_, i) => `?${i + 1}`).join(", ");
  const setClause = ACC_COLS.map((c) => `${c} = ${c} + excluded.${c}`).join(",\n         ");
  const upsertSql =
    `INSERT INTO arb_claim_rollup (${insertCols.join(", ")})\n` +
    `       VALUES (${placeholders})\n` +
    `       ON CONFLICT(carrier) DO UPDATE SET\n         ${setClause}`;

  for (const [carrier, t] of tallies) {
    const binds = [
      carrier,
      t.cases,
      t.rawClaimCents,
      t.rawClaimRows,
      t.rawAwardCents,
      t.rawAwardRows,
      t.cappedCents,
      t.cappedRows,
      t.aboveCap,
      ...t.hist,
    ];
    await env.DB.prepare(upsertSql).bind(...binds).run();
  }

  // A short batch means we reached the end of the eligible set: finalize the
  // sweep. Copy rollup to published, clear the rollup, reset the cursor, and
  // stamp the completion time so claims.json reports when the numbers are from.
  const completed = rows.length < batchSize;
  if (completed) {
    const cols = ["carrier", ...ACC_COLS].join(", ");
    await env.DB.prepare(`DELETE FROM arb_claim_published`).run();
    await env.DB.prepare(
      `INSERT INTO arb_claim_published (${cols})\n       SELECT ${cols} FROM arb_claim_rollup`
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
  const cols = ["carrier", ...ACC_COLS].join(", ");
  const res = await env.DB.prepare(
    `SELECT ${cols}
       FROM arb_claim_published
      ORDER BY claim_capped_total_cents DESC, carrier ASC`
  ).all<StoredRow>();

  const stored = res.results ?? [];
  const byCarrier: ClaimCarrierRow[] = [];
  let totalCappedCents = 0;
  let totalCappedRows = 0;
  let totalAboveCap = 0;
  let totalRows = 0;
  let rawTotalClaimCents = 0;
  const globalHist = new Array(HIST_BUCKETS).fill(0);

  for (const r of stored) {
    const hist = histFromRow(r);
    for (let k = 0; k < HIST_BUCKETS; k++) globalHist[k] += hist[k]!;

    byCarrier.push({
      carrier: r.carrier,
      cases: r.cases,
      claim_capped_total_cents: r.claim_capped_total_cents,
      claim_capped_rows: r.claim_capped_rows,
      claims_above_cap: r.claims_above_cap,
      claim_median_cents_approx: histMedianCents(hist),
      raw_claim_consumer_total_cents: r.raw_claim_consumer_total_cents,
      raw_claim_consumer_parsed_rows: r.raw_claim_consumer_parsed_rows,
      raw_award_consumer_total_cents: r.raw_award_consumer_total_cents,
      raw_award_consumer_parsed_rows: r.raw_award_consumer_parsed_rows,
      methodology: METHODOLOGY,
    });

    totalCappedCents += r.claim_capped_total_cents;
    totalCappedRows += r.claim_capped_rows;
    totalAboveCap += r.claims_above_cap;
    totalRows += r.cases;
    rawTotalClaimCents += r.raw_claim_consumer_total_cents;
  }

  const generatedAt = await getCursor(env, GENERATED_AT_KEY, 0);

  return {
    generated_at: generatedAt,
    source: "aaa_arb excerpts",
    coverage_note: COVERAGE_NOTE,
    methodology: METHODOLOGY,
    byCarrier,
    total_claim_capped_cents: totalCappedCents,
    total_capped_rows: totalCappedRows,
    total_claims_above_cap: totalAboveCap,
    claim_median_cents_approx: histMedianCents(globalHist),
    total_rows: totalRows,
    raw_total_claim_consumer_cents: rawTotalClaimCents,
  };
}

// The robust per-carrier claim figures for the /ask sentence, from the last
// completed sweep. Returns null when that sweep summed no capped claim dollars for
// the carrier, so the caller stays silent rather than printing zeros.
export interface CarrierClaimStats {
  cappedCents: number;
  cappedRows: number;
  aboveCap: number;
  medianCents: number; // non-null whenever cappedRows > 0
}

export async function claimStatsForCarrier(
  env: Env,
  carrier: string
): Promise<CarrierClaimStats | null> {
  const cols = ["claim_capped_total_cents", "claim_capped_rows", "claims_above_cap", ...HB_COLS].join(", ");
  const row = await env.DB.prepare(
    `SELECT ${cols} FROM arb_claim_published WHERE carrier = ?1`
  )
    .bind(carrier)
    .first<Record<string, number>>();

  if (!row) return null;
  const cappedRows = row.claim_capped_rows ?? 0;
  if (cappedRows <= 0) return null;

  const median = histMedianCents(histFromRow(row));
  if (median === null) return null; // cannot happen when cappedRows > 0, defensive

  return {
    cappedCents: row.claim_capped_total_cents ?? 0,
    cappedRows,
    aboveCap: row.claims_above_cap ?? 0,
    medianCents: median,
  };
}
