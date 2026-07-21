import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { collectBluesky } from "../src/collectors/bluesky.js";
import { collectHackerNews } from "../src/collectors/hackernews.js";
import { purgeBluesky } from "../src/purge/bluesky-purge.js";
import { purgeHackerNews } from "../src/purge/hackernews-purge.js";
import { insertRecord } from "../src/db/records.js";
import { getCarrierMentionsMonthly } from "../src/db/aggregates.js";
import bsky from "./fixtures/bsky-search.json";
import hn from "./fixtures/hn-search.json";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.exec("UPDATE sources SET enabled = 1 WHERE id IN ('bluesky','hackernews')");
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM records");
});

describe("no-author-fields guardrail (the one that matters)", () => {
  it("Bluesky rows store the AT-URI and text, never handle/displayName/DID-as-field", async () => {
    const fakeFetch = async () => new Response(JSON.stringify(bsky), { status: 200 });
    await collectBluesky(env, { fetchImpl: fakeFetch });

    const rows = await env.DB.prepare(
      "SELECT dedupe_key, source_url, excerpt, carrier FROM records WHERE source_id = 'bluesky'"
    ).all<{ dedupe_key: string; source_url: string; excerpt: string; carrier: string | null }>();
    // The fixture's off-topic post ("unrelated chatter about the weather") is
    // dropped by the taxonomy gate; only the carrier post becomes a record.
    expect(rows.results!.length).toBe(1);

    const blob = JSON.stringify(rows.results);
    // Author identity from the fixture must appear nowhere in stored fields.
    for (const leak of ["victim.bsky.social", "Jane Doe", "someone.bsky.social", "John Roe"]) {
      expect(blob).not.toContain(leak);
    }
    // The AT-URI is the dedupe key and the source pointer.
    const att = rows.results!.find((r) => r.carrier === "att");
    expect(att!.dedupe_key.startsWith("at://")).toBe(true);
    expect(att!.source_url.startsWith("at://")).toBe(true);
  });

  it("Hacker News rows strip HTML and never store the username", async () => {
    const fakeFetch = async () => new Response(JSON.stringify(hn), { status: 200 });
    await collectHackerNews(env, { fetchImpl: fakeFetch });

    const rows = await env.DB.prepare(
      "SELECT dedupe_key, source_url, excerpt, carrier FROM records WHERE source_id = 'hackernews'"
    ).all<{ dedupe_key: string; source_url: string; excerpt: string; carrier: string | null }>();
    expect(rows.results!.length).toBe(2);

    const blob = JSON.stringify(rows.results);
    expect(blob).not.toContain("secret");
    expect(blob).not.toContain("<b>");
    const tmo = rows.results!.find((r) => r.carrier === "tmobile");
    expect(tmo!.source_url).toBe("https://news.ycombinator.com/item?id=40123456");
  });
});

describe("Bluesky purge honors deletions", () => {
  it("keeps records that resolve and hard-deletes those that do not", async () => {
    const kept = "at://did:plc:keep/app.bsky.feed.post/a";
    const gone = "at://did:plc:gone/app.bsky.feed.post/b";
    for (const uri of [kept, gone]) {
      await insertRecord(env, {
        dedupeKey: uri,
        sourceId: "bluesky",
        sourceUrl: uri,
        captureDate: 1000,
        excerpt: "post",
        vettingStatus: "single_source",
      });
    }

    // getPosts resolves only the kept URI.
    const fakeFetch = async () => new Response(JSON.stringify({ posts: [{ uri: kept }] }), { status: 200 });
    const result = await purgeBluesky(env, { fetchImpl: fakeFetch });
    expect(result.checked).toBe(2);
    expect(result.purged).toBe(1);

    const remaining = await env.DB.prepare("SELECT dedupe_key, last_checked_at FROM records").all<{
      dedupe_key: string;
      last_checked_at: number | null;
    }>();
    expect(remaining.results!.length).toBe(1);
    expect(remaining.results![0]!.dedupe_key).toBe(kept);
    expect(remaining.results![0]!.last_checked_at).toBeGreaterThan(0);
  });

  it("does not purge when the resolve call fails (no false deletions)", async () => {
    const uri = "at://did:plc:x/app.bsky.feed.post/z";
    await insertRecord(env, {
      dedupeKey: uri,
      sourceId: "bluesky",
      sourceUrl: uri,
      captureDate: 1000,
      excerpt: "post",
      vettingStatus: "single_source",
    });
    const failing = async () => new Response("err", { status: 500 });
    const result = await purgeBluesky(env, { fetchImpl: failing });
    expect(result.checked).toBe(0);
    expect(result.purged).toBe(0);
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM records").all<{ n: number }>();
    expect(results![0]!.n).toBe(1);
  });
});

describe("HN purge honors deletions", () => {
  it("purges a 404 item and keeps a live one", async () => {
    for (const id of ["40000001", "40000002"]) {
      await insertRecord(env, {
        dedupeKey: `hn:${id}`,
        sourceId: "hackernews",
        sourceUrl: `https://news.ycombinator.com/item?id=${id}`,
        captureDate: 1000,
        excerpt: "comment",
        vettingStatus: "single_source",
      });
    }
    const fakeFetch = async (u: string) => {
      if (u.endsWith("/40000001")) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ objectID: "40000002" }), { status: 200 });
    };
    const result = await purgeHackerNews(env, { fetchImpl: fakeFetch });
    expect(result.checked).toBe(2);
    expect(result.purged).toBe(1);
    const remaining = await env.DB.prepare("SELECT dedupe_key FROM records").all<{ dedupe_key: string }>();
    expect(remaining.results!.map((r) => r.dedupe_key)).toEqual(["hn:40000002"]);
  });
});

describe("aggregate view", () => {
  it("counts mentions per carrier per month per source, and reflects deletions", async () => {
    const may = Math.floor(Date.UTC(2024, 4, 10) / 1000);
    const may2 = Math.floor(Date.UTC(2024, 4, 20) / 1000);
    const jun = Math.floor(Date.UTC(2024, 5, 5) / 1000);
    const seed = [
      { k: "at://x/app.bsky.feed.post/1", c: "att", d: may, s: "bluesky" },
      { k: "at://x/app.bsky.feed.post/2", c: "att", d: may2, s: "bluesky" },
      { k: "at://x/app.bsky.feed.post/3", c: "verizon", d: jun, s: "bluesky" },
      { k: "hn:1", c: "att", d: may, s: "hackernews" },
    ];
    for (const r of seed) {
      await insertRecord(env, {
        dedupeKey: r.k,
        sourceId: r.s,
        sourceUrl: r.k,
        captureDate: r.d,
        recordDate: r.d,
        excerpt: "x",
        carrier: r.c,
        vettingStatus: "single_source",
      });
    }

    let agg = await getCarrierMentionsMonthly(env);
    const attMayBsky = agg.find((a) => a.carrier === "att" && a.month === "2024-05" && a.source_id === "bluesky");
    expect(attMayBsky!.mentions).toBe(2);
    const attMayHn = agg.find((a) => a.carrier === "att" && a.month === "2024-05" && a.source_id === "hackernews");
    expect(attMayHn!.mentions).toBe(1);

    // Delete one AT&T/May/bluesky post; the aggregate must drop to 1.
    await env.DB.prepare("DELETE FROM records WHERE dedupe_key = 'at://x/app.bsky.feed.post/2'").run();
    agg = await getCarrierMentionsMonthly(env);
    const after = agg.find((a) => a.carrier === "att" && a.month === "2024-05" && a.source_id === "bluesky");
    expect(after!.mentions).toBe(1);
  });
});
