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
    // 123456 + 200000 cents of consumer claims across 2 parsed rows.
    expect(att.cases).toBe(2);
    expect(att.claim_consumer_total_cents).toBe(323456);
    expect(att.claim_consumer_parsed_rows).toBe(2);
    // Only a1 had a parseable award; a2's award cell was empty.
    expect(att.award_consumer_total_cents).toBe(50000);
    expect(att.award_consumer_parsed_rows).toBe(1);

    const vz = agg.byCarrier.find((c) => c.carrier === "verizon")!;
    expect(vz.cases).toBe(1);
    expect(vz.claim_consumer_total_cents).toBe(75000);

    expect(agg.total_claim_consumer_cents).toBe(323456 + 75000);
    expect(agg.total_rows).toBe(3);
    expect(agg.source).toBe("aaa_arb excerpts");
    expect(agg.coverage_note).toMatch(/AAA/);
    expect(agg.coverage_note).toMatch(/could not be parsed/);
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
    expect(att.claim_consumer_parsed_rows).toBe(1); // only t3 parsed
    expect(att.claim_consumer_total_cents).toBe(10000); // only t3's $100
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
    expect(att.claim_consumer_total_cents).toBe(10000);
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
    expect(att.claim_consumer_parsed_rows).toBe(5);
    expect(att.claim_consumer_total_cents).toBe(50000); // exactly 5 * $100, no double count
  });

  it("before any sweep completes the published aggregate is empty and honest", async () => {
    await seedArb("x1", "att", { "claim amt consumer": "$100.00" });
    // No sweep run. Published table is empty.
    const agg = await buildClaimsAggregate(env);
    expect(agg.byCarrier).toHaveLength(0);
    expect(agg.total_claim_consumer_cents).toBe(0);
    expect(agg.total_rows).toBe(0);
    expect(agg.generated_at).toBe(0);
  });
});

describe("/ask count sentence for arbitration dollars", () => {
  it("appends an 'at least $X' sentence only when enabled and after data exists, rounded down", async () => {
    // The sentence is gated behind CONFIG ASK_CLAIMS=on until the robust
    // statistics pass ships: raw claim sums are dominated by absurd outlier
    // asks and read as inflation. Off by default in production.
    await env.CONFIG.put("ASK_CLAIMS", "on");
    await seedArb("d1", "att", { "claim amt consumer": "$1,234.56" });
    await seedArb("d2", "att", { "claim amt consumer": "2000" });

    // Before the sweep: count answer must NOT carry a dollar sentence.
    const before = await answerQuestion(env, "How many AT&T cases are in the library?");
    expect(before.refused).toBe(false);
    expect(before.answer).not.toContain("at least $");

    await runFullSweep(500);

    const after = await answerQuestion(env, "How many AT&T cases are in the library?");
    expect(after.refused).toBe(false);
    // 123456 + 200000 = 323456 cents -> floor $3,234.
    expect(after.answer).toContain("Consumers brought at least $3,234 in claims against AT&T");
    expect(after.answer).toContain("per the AAA public file");
    expect(after.answer).toContain("at least");
  });

  it("appends nothing for a carrier with no parsed dollar data", async () => {
    // Eligible att record but the dollar column is truncated off, so nothing parses.
    await seedArb("n1", "att", { "case id": "1", nonconsumer: "AT&T" });
    await runFullSweep(500);

    const res = await answerQuestion(env, "How many AT&T cases are in the library?");
    expect(res.refused).toBe(false);
    expect(res.answer).not.toContain("at least $");
  });
});
