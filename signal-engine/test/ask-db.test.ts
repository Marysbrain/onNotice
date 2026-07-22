import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { insertRecord } from "../src/db/records.js";
import { answerQuestion } from "../src/ask/answer.js";

const ELIGIBLE_UPDATE =
  "UPDATE records SET review_status='cleared', vetting_status='corroborated' WHERE dedupe_key = ?1";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM records");
  await env.DB.exec("DELETE FROM terms_diffs");
});

async function seed(over: Partial<Parameters<typeof insertRecord>[1]> & { dedupeKey: string }) {
  await insertRecord(env, {
    sourceId: "test",
    sourceUrl: "https://x/" + over.dedupeKey,
    captureDate: 1_700_000_000,
    excerpt: "x",
    vettingStatus: "single_source",
    ...over,
  });
}

async function makeEligible(dedupeKey: string) {
  await env.DB.prepare(ELIGIBLE_UPDATE).bind(dedupeKey).run();
}

describe("eligible-only retrieval (rule 4)", () => {
  it("cites a cleared+corroborated record and never an unrouted one with the same text", async () => {
    await seed({
      dedupeKey: "ok",
      carrier: "att",
      sourceUrl: "https://ok",
      excerpt: "AT&T clawback of trade-in credits reported by customer",
    });
    await makeEligible("ok");

    // Same matching text, but left at the insert defaults (review_status unrouted,
    // vetting single_source). Must never be citable.
    await seed({
      dedupeKey: "bad",
      carrier: "att",
      sourceUrl: "https://bad",
      excerpt: "AT&T clawback of trade-in credits reported by customer",
    });

    const res = await answerQuestion(env, "Tell me about the AT&T clawback of trade-in credits");
    expect(res.refused).toBe(false);
    const urls = res.citations.map((c) => c.source_url);
    expect(urls).toContain("https://ok");
    expect(urls).not.toContain("https://bad");
  });
});

describe("count intent math", () => {
  it("splits eligible records into arbitration, court, and regulator/press buckets", async () => {
    await seed({ dedupeKey: "a1", carrier: "att", sourceId: "aaa_arb", excerpt: "arb one" });
    await seed({ dedupeKey: "a2", carrier: "att", sourceId: "jams_arb", excerpt: "arb two" });
    await seed({ dedupeKey: "c1", carrier: "att", sourceId: "courtlistener", excerpt: "court one" });
    await seed({ dedupeKey: "r1", carrier: "att", sourceId: "ftc_backfill", excerpt: "press one" });
    for (const k of ["a1", "a2", "c1", "r1"]) await makeEligible(k);

    // An ineligible AT&T record and an eligible Verizon record must not be counted.
    await seed({ dedupeKey: "x1", carrier: "att", sourceId: "aaa_arb", excerpt: "not cleared" });
    await seed({ dedupeKey: "v1", carrier: "verizon", sourceId: "aaa_arb", excerpt: "other carrier" });
    await makeEligible("v1");

    const res = await answerQuestion(env, "How many AT&T issues are in the library?");
    expect(res.refused).toBe(false);
    expect(res.answer).toContain("holds 4 records naming AT&T");
    expect(res.answer).toContain("2 consumer arbitration cases");
    expect(res.answer).toContain("1 court record");
    expect(res.answer).toContain("1 regulator or press record");
    // Methodology is always the final citation for a count.
    expect(res.citations[res.citations.length - 1]!.source_id).toBe("methodology");
    expect(res.tags.carrier).toBe("att");
  });
});

describe("cite-or-refuse invariant", () => {
  it("empty retrieval yields the no-results shape, never a bare claim", async () => {
    // Corpus is empty. A topical question can find nothing.
    const res = await answerQuestion(env, "Tell me about slamming complaints against Sprint");
    expect(res.refused).toBe(false);
    expect(res.answer).toContain("doesn't have verified records on that yet");
    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.citations[0]!.source_id).toBe("methodology");
  });

  it("every non-refused answer carries at least one citation", async () => {
    await seed({ dedupeKey: "t1", carrier: "att", excerpt: "AT&T bill credits stopped after a trade-in" });
    await makeEligible("t1");
    const res = await answerQuestion(env, "What happened with AT&T bill credits?");
    expect(res.refused).toBe(false);
    expect(res.citations.length).toBeGreaterThan(0);
  });
});

describe("FTS triggers keep the index in sync", () => {
  it("finds a record after insert and drops it after delete", async () => {
    await seed({
      dedupeKey: "fts1",
      carrier: "tmobile",
      sourceUrl: "https://fts1",
      excerpt: "T-Mobile keep and switch bill credits never arrived",
    });
    await makeEligible("fts1");

    const found = await answerQuestion(env, "keep and switch credits");
    expect(found.citations.map((c) => c.source_url)).toContain("https://fts1");

    await env.DB.prepare("DELETE FROM records WHERE dedupe_key = 'fts1'").run();

    const gone = await answerQuestion(env, "keep and switch credits");
    expect(gone.citations.map((c) => c.source_url)).not.toContain("https://fts1");
    expect(gone.answer).toContain("doesn't have verified records on that yet");
  });

  it("reflects an excerpt change via the update trigger", async () => {
    await seed({
      dedupeKey: "upd1",
      carrier: "verizon",
      sourceUrl: "https://upd1",
      excerpt: "placeholder text with no topic words",
    });
    await makeEligible("upd1");

    const before = await answerQuestion(env, "unjust enrichment forfeiture");
    expect(before.citations.map((c) => c.source_url)).not.toContain("https://upd1");

    await env.DB.prepare(
      "UPDATE records SET excerpt = 'Verizon unjust enrichment from forfeited credits' WHERE dedupe_key = 'upd1'"
    ).run();

    const after = await answerQuestion(env, "unjust enrichment forfeiture");
    expect(after.citations.map((c) => c.source_url)).toContain("https://upd1");
  });
});

describe("walls short-circuit before retrieval", () => {
  it("refuses founder questions with the fixed sentence and no citations", async () => {
    await seed({ dedupeKey: "f1", carrier: "att", excerpt: "AT&T clawback" });
    await makeEligible("f1");
    const res = await answerQuestion(env, "What happened with Michael and AT&T?");
    expect(res.refused).toBe(true);
    expect(res.citations.length).toBe(0);
    expect(res.answer).toContain("personal matters");
  });

  it("opinion question attaches records when it can, prepending the opinion sentence", async () => {
    await seed({ dedupeKey: "o1", carrier: "att", excerpt: "AT&T clawback of promotional credits" });
    await makeEligible("o1");
    const res = await answerQuestion(env, "What do you think about the AT&T clawback?");
    expect(res.refused).toBe(false);
    expect(res.answer).toContain("The commentary on this site is Michael's");
    expect(res.citations.length).toBeGreaterThan(0);
  });

  it("opinion question with no records refuses with the opinion sentence only", async () => {
    const res = await answerQuestion(env, "What do you think about slamming at Sprint?");
    expect(res.refused).toBe(true);
    expect(res.citations.length).toBe(0);
    expect(res.answer).toContain("The commentary on this site is Michael's");
  });
});
