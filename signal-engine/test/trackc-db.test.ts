import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { insertRecord } from "../src/db/records.js";
import { runClassify } from "../src/classify/run.js";
import { runCorroborate } from "../src/classify/corroborate.js";
import { runLinks } from "../src/classify/links.js";
import { runPublish } from "../src/publish/publish.js";
import { StubClassifier } from "../src/classify/classifier.js";
import { insertFccMonthly } from "../src/db/fcc.js";

const DAY = 24 * 60 * 60;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM records");
  await env.DB.exec("DELETE FROM links");
  await env.DB.exec("DELETE FROM terms_diffs");
  await env.CONFIG.delete("cursor:links_cursor");
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

describe("confidence routing", () => {
  it("deterministic hit clears without calling the AI stage, and never touches vetting", async () => {
    const throwing = new StubClassifier(() => {
      throw new Error("AI must not be called for a deterministic hit");
    });
    await seed({ dedupeKey: "det", excerpt: "T-Mobile keep and switch bill credits vanished" });
    const res = await runClassify(env, throwing);
    expect(res.cleared).toBe(1);

    const row = await env.DB.prepare("SELECT carrier, confidence, review_status, review_reason, vetting_status FROM records WHERE dedupe_key='det'").first<{
      carrier: string;
      confidence: number;
      review_status: string;
      review_reason: string | null;
      vetting_status: string;
    }>();
    expect(row!.carrier).toBe("tmobile");
    expect(row!.confidence).toBe(0.95);
    expect(row!.review_status).toBe("cleared");
    expect(row!.review_reason).toBe(null);
    expect(row!.vetting_status).toBe("single_source"); // guardrail: not touched
  });

  it("AI confidence at/above the bar clears, below the bar queues with a reason", async () => {
    const stub = new StubClassifier((i) => ({
      carrier: "att",
      promo_name: null,
      alleged_issue: "billing",
      confidence: i.excerpt.includes("HIGH") ? 0.9 : 0.5,
      rationale: "stub",
    }));
    await seed({ dedupeKey: "hi", excerpt: "HIGH ambiguous mention" });
    await seed({ dedupeKey: "lo", excerpt: "LOW ambiguous mention" });

    const res = await runClassify(env, stub);
    expect(res.cleared).toBe(1);
    expect(res.queued).toBe(1);

    const hi = await env.DB.prepare("SELECT review_status FROM records WHERE dedupe_key='hi'").first<{ review_status: string }>();
    const lo = await env.DB.prepare("SELECT review_status, review_reason FROM records WHERE dedupe_key='lo'").first<{ review_status: string; review_reason: string }>();
    expect(hi!.review_status).toBe("cleared");
    expect(lo!.review_status).toBe("queued");
    expect(lo!.review_reason).toContain("below bar");
  });
});

describe("corroboration", () => {
  it("upgrades when two different sources agree within 90 days", async () => {
    await seed({ dedupeKey: "c1", sourceId: "bluesky", carrier: "att", allegedIssue: "promo_removed", recordDate: 1_700_000_000 });
    await seed({ dedupeKey: "c2", sourceId: "hackernews", carrier: "att", allegedIssue: "promo_removed", recordDate: 1_700_000_000 + 10 * DAY });
    const res = await runCorroborate(env);
    expect(res.upgraded).toBe(2);
    const rows = await env.DB.prepare("SELECT vetting_status FROM records WHERE dedupe_key IN ('c1','c2')").all<{ vetting_status: string }>();
    expect(rows.results!.every((r) => r.vetting_status === "corroborated")).toBe(true);
  });

  it("does not upgrade when the same source appears twice", async () => {
    await seed({ dedupeKey: "s1", sourceId: "bluesky", carrier: "att", allegedIssue: "promo_removed", recordDate: 1_700_000_000 });
    await seed({ dedupeKey: "s2", sourceId: "bluesky", carrier: "att", allegedIssue: "promo_removed", recordDate: 1_700_000_000 + 5 * DAY });
    const res = await runCorroborate(env);
    expect(res.upgraded).toBe(0);
    const rows = await env.DB.prepare("SELECT vetting_status FROM records WHERE dedupe_key IN ('s1','s2')").all<{ vetting_status: string }>();
    expect(rows.results!.every((r) => r.vetting_status === "single_source")).toBe(true);
  });

  it("never sets verified_primary by machine", async () => {
    await seed({ dedupeKey: "v1", sourceId: "bluesky", carrier: "att", allegedIssue: "x", recordDate: 1_700_000_000 });
    await seed({ dedupeKey: "v2", sourceId: "news_gdelt", carrier: "att", allegedIssue: "x", recordDate: 1_700_000_000 });
    await runCorroborate(env);
    const any = await env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE vetting_status='verified_primary'").first<{ n: number }>();
    expect(any!.n).toBe(0);
  });
});

describe("link building", () => {
  it("builds each documented link type with a basis, and honors the unique constraint", async () => {
    await seed({ dedupeKey: "l1", carrier: "att", promoName: "next up", allegedIssue: "bill_credits", recordDate: 1_700_000_000 });
    await seed({ dedupeKey: "l2", carrier: "att", promoName: "next up", allegedIssue: "bill_credits", recordDate: 1_700_000_000 + 10 * DAY });
    await env.DB.exec("UPDATE records SET review_status='cleared' WHERE dedupe_key IN ('l1','l2')");
    // A terms diff mentioning the promo, so same_promo_terms_language can fire.
    await env.DB.prepare(
      "INSERT INTO terms_diffs (target, to_snap_id, to_hash, diff) VALUES ('terms_att_promo', 1, 'h', ?1)"
    ).bind("- old\n+ new next up offer language").run();

    const res = await runLinks(env);
    expect(res.links).toBeGreaterThan(0);

    const links = await env.DB.prepare("SELECT link_type, basis FROM links ORDER BY link_type").all<{ link_type: string; basis: string }>();
    const types = new Set(links.results!.map((l) => l.link_type));
    expect(types.has("same_carrier_promo")).toBe(true);
    expect(types.has("same_carrier_issue_window")).toBe(true);
    expect(types.has("same_promo_terms_language")).toBe(true);
    expect(types.has("same_claim_type")).toBe(true);
    expect(links.results!.find((l) => l.link_type === "same_carrier_promo")!.basis).toContain("promo=next up");

    // Re-run: unique constraint means no duplicates. Reset cursor to re-scan.
    await env.CONFIG.delete("cursor:links_cursor");
    const before = links.results!.length;
    await runLinks(env);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM links").first<{ n: number }>();
    expect(after!.n).toBe(before);
  });
});

describe("aggregates publisher", () => {
  it("writes map (from FCC aggregates), mentions, and totals with the strict verified count", async () => {
    // Map now comes from the FCC monthly aggregates table, not row-level records.
    await insertFccMonthly(env, [
      { month: "2015-03", state: "NV", zip: null, method: null, count: 2 },
      { month: "2015-03", state: "CA", zip: null, method: null, count: 1 },
      { month: "2015-03", state: null, zip: "89501", method: null, count: 2 },
    ]);

    // Vetting spread for totals.
    await seed({ dedupeKey: "t1", carrier: "att", allegedIssue: "x", recordDate: 1_700_000_000, vettingStatus: "corroborated" });
    await seed({ dedupeKey: "t2", carrier: "att", allegedIssue: "x", recordDate: 1_700_000_000, vettingStatus: "verified_primary" });

    const res = await runPublish(env);
    expect(res.totals).toBeGreaterThan(0);

    const mapObj = JSON.parse(await (await env.RAW.get("aggregates/map.json"))!.text());
    expect(mapObj.source).toBe("fcc_monthly_aggregates");
    expect(mapObj.byState.find((s: { state: string }) => s.state === "NV").count).toBe(2);
    expect(mapObj.byState.find((s: { state: string }) => s.state === "CA").count).toBe(1);

    const totalsObj = JSON.parse(await (await env.RAW.get("aggregates/totals.json"))!.text());
    expect(totalsObj.verified).toBe(2); // corroborated + verified_primary only

    const mentionsObj = JSON.parse(await (await env.RAW.get("aggregates/mentions.json"))!.text());
    expect(Array.isArray(mentionsObj.rows)).toBe(true);

    // No excerpts leak into any published file.
    const blob = JSON.stringify(mapObj) + JSON.stringify(totalsObj) + JSON.stringify(mentionsObj);
    expect(blob).not.toContain("excerpt");
  });
});
