import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { insertRecord } from "../src/db/records.js";
import { advanceClaims, buildClaimsAggregate } from "../src/publish/claims.js";
import { answerQuestion } from "../src/ask/answer.js";

const ELIGIBLE_UPDATE =
  "UPDATE records SET review_status='cleared', vetting_status='verified_primary' WHERE dedupe_key = ?1";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM records");
  await env.DB.exec("DELETE FROM arb_claim_rollup");
  await env.DB.exec("DELETE FROM arb_claim_published");
  await env.CONFIG.delete("cursor:publish_claims_id");
  await env.CONFIG.delete("cursor:publish_claims_at");
});

// Build an aaa_arb excerpt in the real stored shape:
// "Company | key=value; key=value; ...".
function excerpt(company: string, cols: Record<string, string>): string {
  const body = Object.entries(cols)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return `${company} | ${body}`;
}

async function seedArb(
  dedupeKey: string,
  carrier: string,
  cols: Record<string, string>,
  opts: { eligible?: boolean; sourceId?: string; company?: string } = {}
) {
  await insertRecord(env, {
    dedupeKey,
    sourceId: opts.sourceId ?? "aaa_arb",
    sourceUrl: "https://arb/" + dedupeKey,
    captureDate: 1_700_000_000,
    excerpt: excerpt(opts.company ?? "Some Co", cols),
    carrier,
    vettingStatus: "single_source",
  });
  if (opts.eligible ?? true) {
    await env.DB.prepare(ELIGIBLE_UPDATE).bind(dedupeKey).run();
  }
}

// Drive a full sweep to completion, using a small batch to exercise the
// cross-run cursor. Guarded against runaway loops.
async function runFullSweep(batchSize: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { completed } = await advanceClaims(env, batchSize);
    if (completed) return;
  }
  throw new Error("sweep did not complete");
}

describe("claims aggregation math", () => {
  it("sums consumer claim and award cents per carrier and counts parsed rows", async () => {
    await seedArb("a1", "att", {
      "claim amt consumer": "$1,234.56",
      "claim amt business": "$0.00",
      "award amt consumer": "$500.00",
    });
    await seedArb("a2", "att", {
      "claim amt consumer": "2000",
      "award amt consumer": "",
    });
    await seedArb("v1", "verizon", {
      "claim amt consumer": "$750.00",
      "award amt consumer": "$750.00",
    });

    await runFullSweep(500);
    const agg = await buildClaimsAggregate(env);

    const att = agg.byCarrier.find((c) => c.carrier === "att")!;
    // 123456 + 200000 cents of consumer claims across 2 parsed rows. Both under
    // the cap, so the capped sum equals the raw sum here.
    expect(att.cases).toBe(2);
    expect(att.raw_claim_consumer_total_cents).toBe(323456);
    expect(att.raw_claim_consumer_parsed_rows).toBe(2);
    expect(att.claim_capped_total_cents).toBe(323456);
    expect(att.claim_capped_rows).toBe(2);
    expect(att.claims_above_cap).toBe(0);
    // Only a1 had a parseable award; a2's award cell was empty.
    expect(att.raw_award_consumer_total_cents).toBe(50000);
    expect(att.raw_award_consumer_parsed_rows).toBe(1);

    const vz = agg.byCarrier.find((c) => c.carrier === "verizon")!;
    expect(vz.cases).toBe(1);
    expect(vz.raw_claim_consumer_total_cents).toBe(75000);
    expect(vz.claim_capped_total_cents).toBe(75000);

    expect(agg.total_claim_capped_cents).toBe(323456 + 75000);
    expect(agg.raw_total_claim_consumer_cents).toBe(323456 + 75000);
    expect(agg.total_claims_above_cap).toBe(0);
    expect(agg.total_rows).toBe(3);
    expect(agg.source).toBe("aaa_arb excerpts");
    expect(agg.coverage_note).toMatch(/AAA/);
    expect(agg.methodology.cap_cents).toBe(2_500_000);
    expect(agg.methodology.median_method).toBe("histogram approximation");
    // Methodology must not contain an em dash anywhere (RULE 2).
    expect(agg.methodology.note).not.toContain(String.fromCharCode(0x2014));
    expect(agg.coverage_note).not.toContain(String.fromCharCode(0x2014));
  });

  it("truncated or unparseable dollar cells contribute zero and are not counted parsed", async () => {
    // Row with the consumer claim column cut off entirely by truncation.
    await seedArb("t1", "att", { "case id": "1", nonconsumer: "AT&T" });
    // Row with a truncated remnant "$1,23" (malformed grouping -> rejected).
    await seedArb("t2", "att", { "claim amt consumer": "$1,23" });
    // Row that parses cleanly.
    await seedArb("t3", "att", { "claim amt consumer": "$100.00" });

    await runFullSweep(500);
    const agg = await buildClaimsAggregate(env);
    const att = agg.byCarrier.find((c) => c.carrier === "att")!;

    expect(att.cases).toBe(3); // every eligible case is counted
    expect(att.raw_claim_consumer_parsed_rows).toBe(1); // only t3 parsed
    expect(att.raw_claim_consumer_total_cents).toBe(10000); // only t3's $100
    expect(att.claim_capped_total_cents).toBe(10000);
    expect(att.claim_capped_rows).toBe(1);
  });

  it("only cleared + corroborated-or-better aaa_arb rows feed the aggregate", async () => {
    await seedArb("ok", "att", { "claim amt consumer": "$100.00" });
    // Ineligible: left at insert defaults.
    await seedArb("nope", "att", { "claim amt consumer": "$999.00" }, { eligible: false });
    // Wrong source: an eligible non-aaa row must not be summed here.
    await seedArb("court", "att", { "claim amt consumer": "$999.00" }, { sourceId: "courtlistener" });

    await runFullSweep(500);
    const agg = await buildClaimsAggregate(env);
    const att = agg.byCarrier.find((c) => c.carrier === "att")!;

    expect(att.cases).toBe(1);
    expect(att.claim_capped_total_cents).toBe(10000);
  });

  it("spreading a sweep across runs gives the same totals and never double counts", async () => {
    for (let i = 0; i < 5; i++) {
      await seedArb(`b${i}`, "att", { "claim amt consumer": "$100.00" });
    }
    // Batch of 2 forces multiple runs (3 batches + a final short batch).
    await runFullSweep(2);
    const agg = await buildClaimsAggregate(env);
    const att = agg.byCarrier.find((c) => c.carrier === "att")!;

    expect(att.cases).toBe(5);
    expect(att.raw_claim_consumer_parsed_rows).toBe(5);
    expect(att.claim_capped_rows).toBe(5);
    expect(att.claim_capped_total_cents).toBe(50000); // exactly 5 * $100, no double count
  });

  it("before any sweep completes the published aggregate is empty and honest", async () => {
    await seedArb("x1", "att", { "claim amt consumer": "$100.00" });
    // No sweep run. Published table is empty.
    const agg = await buildClaimsAggregate(env);
    expect(agg.byCarrier).toHaveLength(0);
    expect(agg.total_claim_capped_cents).toBe(0);
    expect(agg.raw_total_claim_consumer_cents).toBe(0);
    expect(agg.claim_median_cents_approx).toBeNull();
    expect(agg.total_rows).toBe(0);
    expect(agg.generated_at).toBe(0);
  });
});

describe("cap edges and outlier exclusion", () => {
  it("a claim exactly at the cap is summed; one cent over is not", async () => {
    // $25,000.00 == 2,500,000 cents, exactly at the cap: summed.
    await seedArb("at-cap", "att", { "claim amt consumer": "$25,000.00" });
    // $25,000.01 == 2,500,001 cents, one cent over: counted, never summed.
    await seedArb("over-cap", "att", { "claim amt consumer": "$25,000.01" });

    await runFullSweep(500);
    const att = (await buildClaimsAggregate(env)).byCarrier.find((c) => c.carrier === "att")!;

    expect(att.cases).toBe(2);
    expect(att.claim_capped_total_cents).toBe(2_500_000); // only the at-cap row
    expect(att.claim_capped_rows).toBe(1);
    expect(att.claims_above_cap).toBe(1);
    // Raw still sees both, for audit.
    expect(att.raw_claim_consumer_total_cents).toBe(2_500_000 + 2_500_001);
    expect(att.raw_claim_consumer_parsed_rows).toBe(2);
  });

  it("a billion-dollar ask lands in claims_above_cap and in no sum", async () => {
    await seedArb("normal", "att", { "claim amt consumer": "$500.00" });
    await seedArb("moon", "att", { "claim amt consumer": "$1,000,000,000" });

    await runFullSweep(500);
    const att = (await buildClaimsAggregate(env)).byCarrier.find((c) => c.carrier === "att")!;

    expect(att.claim_capped_total_cents).toBe(50000); // only the $500 row
    expect(att.claim_capped_rows).toBe(1);
    expect(att.claims_above_cap).toBe(1);
    // The billion-dollar ask is nowhere in a capped total. The robust total is
    // unmoved by it. (It survives only in the audit-only raw sum.)
    expect(att.claim_capped_total_cents).toBeLessThan(2_500_000);
    expect(att.raw_claim_consumer_total_cents).toBe(50000 + 100_000_000_000);
  });

  it("a schema/methodology generation bump restarts the sweep with no manual surgery", async () => {
    // Simulate an old generation left mid-sweep by the previous (raw-sum) schema:
    // a stale cursor and stale rows in both tables.
    await env.CONFIG.put("cursor:publish_claims_generation", "1");
    await env.CONFIG.put("cursor:publish_claims_id", "999999");
    await env.DB.prepare(
      `INSERT INTO arb_claim_rollup (carrier, cases, claim_capped_total_cents, claim_capped_rows) VALUES ('stale', 9, 999, 9)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO arb_claim_published (carrier, cases, claim_capped_total_cents, claim_capped_rows) VALUES ('stale', 9, 999, 9)`
    ).run();

    await seedArb("fresh", "att", { "claim amt consumer": "$100.00" });
    await runFullSweep(500);

    const agg = await buildClaimsAggregate(env);
    // The stale carrier is gone and the cursor restarted from 0, so the fresh
    // record was swept even though the stale cursor pointed past it.
    expect(agg.byCarrier.map((c) => c.carrier)).toEqual(["att"]);
    expect(agg.byCarrier[0]!.claim_capped_total_cents).toBe(10000);
  });
});

describe("/ask robust dollar sentences for arbitration", () => {
  it("speaks a capped sum and an approximate median, only when enabled and after data exists", async () => {
    await env.CONFIG.put("ASK_CLAIMS", "on");
    await seedArb("d1", "att", { "claim amt consumer": "$1,234.56" });
    await seedArb("d2", "att", { "claim amt consumer": "2000" });

    // Before the sweep: count answer must NOT carry a dollar sentence.
    const before = await answerQuestion(env, "How many AT&T cases are in the library?");
    expect(before.refused).toBe(false);
    expect(before.answer).not.toContain("$25,000");

    await runFullSweep(500);

    const after = await answerQuestion(env, "How many AT&T cases are in the library?");
    expect(after.refused).toBe(false);
    // Both claims are under the cap. Capped sum 123456 + 200000 = 323456 -> floor
    // $3,234. Histogram median of {123456, 200000} interpolates to 131072 cents,
    // snapped to the nearest $10 -> $1,310.
    expect(after.answer).toContain(
      "Among the 2 AT&T cases with a parsed claim at or under $25,000, consumers claimed a combined $3,234, with a typical claim near $1,310."
    );
    // No outlier asks here, so the second sentence must be absent.
    expect(after.answer).not.toContain("counted but not summed");
    // The raw, inflated phrasing must never appear.
    expect(after.answer).not.toContain("at least $");
  });

  it("adds the outlier sentence only when filings exceed the cap", async () => {
    await env.CONFIG.put("ASK_CLAIMS", "on");
    await seedArb("u1", "verizon", { "claim amt consumer": "$800.00" });
    await seedArb("u2", "verizon", { "claim amt consumer": "$1,000,000,000" });
    await runFullSweep(500);

    const res = await answerQuestion(env, "How many Verizon cases are in the library?");
    expect(res.refused).toBe(false);
    // One capped ($800) and one billion-dollar ask above the cap.
    expect(res.answer).toContain("with a parsed claim at or under $25,000");
    expect(res.answer).toContain("a combined $800");
    expect(res.answer).toContain("1 filing claimed more than $25,000 and is counted but not summed.");
  });

  it("stays silent for a carrier whose capped rows are zero (only outliers or nothing parses)", async () => {
    await env.CONFIG.put("ASK_CLAIMS", "on");
    // Eligible att record but the dollar column is truncated off, so nothing parses.
    await seedArb("n1", "att", { "case id": "1", nonconsumer: "AT&T" });
    // And an all-outlier carrier: a single above-cap ask, zero capped rows.
    await seedArb("z1", "tmobile", { "claim amt consumer": "$40,000.00" });
    await runFullSweep(500);

    const att = await answerQuestion(env, "How many AT&T cases are in the library?");
    expect(att.refused).toBe(false);
    expect(att.answer).not.toContain("$25,000");

    const tmo = await answerQuestion(env, "How many T-Mobile cases are in the library?");
    expect(tmo.refused).toBe(false);
    // Zero capped rows -> no dollar sentence at all, even though an outlier exists.
    expect(tmo.answer).not.toContain("$25,000");
    expect(tmo.answer).not.toContain("counted but not summed");
  });
});
