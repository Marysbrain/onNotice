import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { insertRecord } from "../src/db/records.js";
import { insertFccMonthly } from "../src/db/fcc.js";
import { spendBudget } from "../src/lib/config.js";
import { runCourtListenerBackfill } from "../src/backfill/courtlistener-backfill.js";
import { runPublish } from "../src/publish/publish.js";

const today = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM records");
  await env.DB.exec("DELETE FROM links");
  await env.DB.exec("DELETE FROM fcc_monthly_aggregates");
  for (const k of ["cursor:publish_state_idx", "cursor:publish_record_id", "cursor:courtlistener", `budget:courtlistener:${today}`]) {
    await env.CONFIG.delete(k);
  }
});

async function seed(over: Partial<Parameters<typeof insertRecord>[1]> & { dedupeKey: string }): Promise<number> {
  await insertRecord(env, {
    sourceId: "test",
    sourceUrl: "https://x/" + over.dedupeKey,
    captureDate: 1_700_000_000,
    excerpt: "x",
    vettingStatus: "single_source",
    ...over,
  });
  const row = await env.DB.prepare("SELECT id FROM records WHERE dedupe_key = ?1").bind(over.dedupeKey).first<{ id: number }>();
  return row!.id;
}

describe("daily budget counter", () => {
  it("allows up to the limit then stops, and resumes on a new day", async () => {
    expect((await spendBudget(env, "t", 2, "2099-01-01")).allowed).toBe(true);
    expect((await spendBudget(env, "t", 2, "2099-01-01")).allowed).toBe(true);
    expect((await spendBudget(env, "t", 2, "2099-01-01")).allowed).toBe(false);
    // A different day has its own counter.
    expect((await spendBudget(env, "t", 2, "2099-01-02")).allowed).toBe(true);
  });
});

describe("CourtListener backfill", () => {
  it("stops immediately when the daily budget is spent", async () => {
    await env.CONFIG.put(`budget:courtlistener:${today}`, "125");
    let called = false;
    const fakeFetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    const res = await runCourtListenerBackfill(env, { fetchImpl: fakeFetch });
    expect(called).toBe(false);
    expect(res.calls).toBe(0);
    expect(res.budgetExhausted).toBe(true);
  });

  it("inserts docket records and spends budget", async () => {
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            { caseName: "Doe v. AT&T Mobility", court: "cacd", dateFiled: "2021-05-01", docketNumber: "2:21-cv-1", absolute_url: "/docket/1/a/" },
            { caseName: "Roe v. Verizon", court: "nysd", dateFiled: "2020-02-02", docketNumber: "1:20-cv-2", absolute_url: "/docket/2/b/" },
          ],
        }),
        { status: 200 }
      );
    const res = await runCourtListenerBackfill(env, { fetchImpl: fakeFetch });
    expect(res.calls).toBe(3);
    expect(res.inserted).toBe(2); // same two urls across calls dedupe
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE source_id='courtlistener'").first<{ n: number }>();
    expect(n!.n).toBe(2);
    const used = Number(await env.CONFIG.get(`budget:courtlistener:${today}`));
    expect(used).toBe(3);
  });
});

describe("FCC aggregates feed the map", () => {
  it("map.json is built from fcc_monthly_aggregates, not row-level records", async () => {
    await insertFccMonthly(env, [
      { month: "2015-03", state: "NV", zip: null, method: null, count: 1000 },
      { month: "2015-04", state: "NV", zip: null, method: null, count: 500 },
      { month: "2015-03", state: null, zip: "89501", method: null, count: 60 },
    ]);
    await runPublish(env);
    const map = JSON.parse(await (await env.RAW.get("aggregates/map.json"))!.text());
    expect(map.source).toBe("fcc_monthly_aggregates");
    expect(map.byState.find((s: { state: string }) => s.state === "NV").count).toBe(1500);
    expect(map.byZip.some((z: { zip: string }) => z.zip === "89501")).toBe(true);
    const hs = JSON.parse(await (await env.RAW.get("aggregates/hotspots.json"))!.text());
    expect(hs.hotspots.some((h: { state: string }) => h.state === "NV")).toBe(true);
  });
});

describe("rabbit hole per-state and per-record files, privacy filter", () => {
  it("exposes only cleared corroborated-or-better records, no excerpts, permalink for social", async () => {
    await insertFccMonthly(env, [{ month: "2015-03", state: "NV", zip: null, method: null, count: 1000 }]);

    const a = await seed({
      dedupeKey: "at://did:plc:abc/app.bsky.feed.post/rk",
      sourceId: "bluesky",
      excerpt: "SECRET POST TEXT that must never publish",
      carrier: "att",
      allegedIssue: "bill_credits",
      locState: "NV",
      recordDate: 1_700_000_000,
      vettingStatus: "corroborated",
    });
    await env.DB.exec("UPDATE records SET source_url='at://did:plc:abc/app.bsky.feed.post/rk', review_status='cleared' WHERE id=" + a);

    const b = await seed({
      dedupeKey: "at://did:plc:xyz/app.bsky.feed.post/rk2",
      sourceId: "bluesky",
      excerpt: "HIDDEN LEAD single source",
      locState: "NV",
      vettingStatus: "single_source",
    });
    await env.DB.exec("UPDATE records SET review_status='cleared' WHERE id=" + b);

    const c = await seed({
      dedupeKey: "ftc:https://ftc.gov/x",
      sourceId: "ftc_backfill",
      sourceUrl: "https://ftc.gov/x",
      excerpt: "ftc release",
      carrier: "att",
      allegedIssue: "bill_credits",
      locState: "NV",
      recordDate: 1_700_000_100,
      vettingStatus: "verified_primary",
    });
    await env.DB.exec("UPDATE records SET review_status='cleared' WHERE id=" + c);

    // Link between the two displayable records, and a link touching the excluded one.
    await env.DB.prepare("INSERT INTO links (record_id_a, record_id_b, link_type, basis) VALUES (?1,?2,'same_claim_type','issue=bill_credits')")
      .bind(Math.min(a, c), Math.max(a, c)).run();
    await env.DB.prepare("INSERT INTO links (record_id_a, record_id_b, link_type, basis) VALUES (?1,?2,'same_claim_type','issue=bill_credits')")
      .bind(Math.min(a, b), Math.max(a, b)).run();

    await runPublish(env);

    const stateDoc = JSON.parse(await (await env.RAW.get("aggregates/states/NV.json"))!.text());
    const blob = JSON.stringify(stateDoc);
    expect(blob).not.toContain("SECRET POST TEXT");
    expect(blob).not.toContain("HIDDEN LEAD");
    expect(blob).not.toContain("excerpt");
    const ids = stateDoc.records.map((r: { id: number }) => r.id).sort();
    expect(ids).toEqual([a, c].sort((x, y) => x - y));
    const socialRec = stateDoc.records.find((r: { id: number }) => r.id === a);
    expect(socialRec.source_url).toBe("https://bsky.app/profile/did:plc:abc/post/rk");
    expect(stateDoc.top_issues.some((t: { issue: string }) => t.issue === "bill_credits")).toBe(true);
    expect(stateDoc.monthly_trend.length).toBeGreaterThan(0);

    // Per-record citation file for the social record: no excerpt, permalink used.
    const recDoc = JSON.parse(await (await env.RAW.get(`aggregates/records/${a}.json`))!.text());
    expect(recDoc.source_url).toBe("https://bsky.app/profile/did:plc:abc/post/rk");
    expect(JSON.stringify(recDoc)).not.toContain("SECRET POST TEXT");

    // Links graph: only the edge between the two displayable records.
    const graph = JSON.parse(await (await env.RAW.get("aggregates/links.json"))!.text());
    expect(graph.nodes.sort()).toEqual([a, c].sort((x, y) => x - y));
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0].basis).toContain("bill_credits");
  });
});
