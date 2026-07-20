import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { collectNews } from "../src/collectors/news.js";
import gdelt from "./fixtures/gdelt.json";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // Enable only the GDELT source for these tests. Google News stays off.
  await env.DB.exec("UPDATE sources SET enabled = 1 WHERE id = 'news_gdelt'");
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM records");
});

describe("news radar writes lead records with the right shape", () => {
  it("stores headline, domain, link, date, and lead source id, no location", async () => {
    const fakeFetch = async () => new Response(JSON.stringify(gdelt), { status: 200 });
    const result = await collectNews(env, { fetchImpl: fakeFetch });

    const gdeltResult = result.find((r) => r.source === "news_gdelt");
    expect(gdeltResult?.new).toBe(2);

    const rows = await env.DB.prepare(
      "SELECT dedupe_key, source_id, source_url, excerpt, carrier, loc_city, vetting_status FROM records ORDER BY dedupe_key"
    ).all<{
      dedupe_key: string;
      source_id: string;
      source_url: string;
      excerpt: string;
      carrier: string | null;
      loc_city: string | null;
      vetting_status: string;
    }>();
    expect(rows.results!.length).toBe(2);

    const first = rows.results![0]!;
    expect(first.source_id).toBe("news_gdelt");
    expect(first.dedupe_key.startsWith("news:gdelt:")).toBe(true);
    expect(first.source_url).toContain("http");
    expect(first.excerpt).toContain("|"); // headline | domain
    expect(first.loc_city).toBe(null); // discovery, no location
    expect(first.vetting_status).toBe("single_source"); // never a verified count

    // The T-Mobile headline should be carrier-tagged.
    const tagged = rows.results!.find((r) => r.carrier === "tmobile");
    expect(tagged).toBeTruthy();
  });

  it("is idempotent on re-run (dedupe by link)", async () => {
    const fakeFetch = async () => new Response(JSON.stringify(gdelt), { status: 200 });
    await collectNews(env, { fetchImpl: fakeFetch });
    await collectNews(env, { fetchImpl: fakeFetch });
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM records").all<{ n: number }>();
    expect(results![0]!.n).toBe(2);
  });
});
