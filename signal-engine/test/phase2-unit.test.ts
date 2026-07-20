import { describe, it, expect } from "vitest";
import { resolveCikFromTickerFile, parseEdgarHits } from "../src/collectors/edgar.js";
import { buildSocrataQuery, nextCursor, socrataDedupeKey } from "../src/collectors/socrata.js";
import { classifyFiler, parseEcfsFilings, buildFilingExcerpt } from "../src/collectors/ecfs.js";
import { parseGdelt, parseGdeltDate, newsSource, buildNewsQuery } from "../src/collectors/news.js";
import { fetchWithRetry, parseRetryAfter } from "../src/lib/http.js";
import { matchIssueTerms, hasTaxonomyMatch, promoNamesFor } from "../src/lib/taxonomy.js";
import edgarHits from "./fixtures/edgar-hits.json";
import ecfsFilings from "./fixtures/ecfs-filings.json";
import gdelt from "./fixtures/gdelt.json";

describe("EDGAR", () => {
  it("resolves a CIK from the ticker file without full JSON.parse", () => {
    const file =
      '{"0":{"cik_str":320193,"ticker":"AAPL","title":"Apple Inc."},"1":{"cik_str":732717,"ticker":"T","title":"AT&T INC."}}';
    expect(resolveCikFromTickerFile(file, "T")).toBe("0000732717");
    expect(resolveCikFromTickerFile(file, "NOPE")).toBe(null);
  });

  it("parses FTS hits into items with a canonical Archives URL", () => {
    const items = parseEdgarHits(edgarHits);
    expect(items.length).toBe(1);
    expect(items[0]!.accession).toBe("0000732717-24-000045");
    expect(items[0]!.url).toBe("https://www.sec.gov/Archives/edgar/data/732717/000073271724000045/att10q.htm");
    expect(items[0]!.fileDate).toBe("2024-05-01");
    expect(items[0]!.title).toContain("10-Q");
  });

  it("returns empty on malformed input", () => {
    expect(parseEdgarHits({})).toEqual([]);
    expect(parseEdgarHits(null)).toEqual([]);
  });
});

describe("Socrata incremental cursor", () => {
  it("omits the cursor filter on the first pull", () => {
    const url = buildSocrataQuery("https://opendata.fcc.gov/resource/3xyp-aqkj.json", null, 25, 0);
    expect(url).toContain("issue_type%3D%27Phone%27");
    expect(url).not.toContain("ticket_created+%3E");
    expect(url).toContain("%24limit=25");
  });

  it("adds a ticket_created filter once a cursor exists", () => {
    const url = buildSocrataQuery("https://x/y.json", "2024-05-01T00:00:00.000", 25, 50);
    // URLSearchParams encodes spaces as '+', which decodeURIComponent leaves
    // intact, so normalize them before asserting.
    const decoded = decodeURIComponent(url).replace(/\+/g, " ");
    expect(decoded).toContain("ticket_created > '2024-05-01T00:00:00.000'");
    expect(decoded).toContain("$offset=50");
  });

  it("advances the cursor to the max ticket_created seen", () => {
    const rows = [
      { ticket_created: "2024-05-01T10:00:00.000" },
      { ticket_created: "2024-05-03T09:00:00.000" },
      { ticket_created: "2024-05-02T11:00:00.000" },
    ];
    expect(nextCursor(rows, "2024-04-30T00:00:00.000")).toBe("2024-05-03T09:00:00.000");
    expect(nextCursor([], "2024-04-30T00:00:00.000")).toBe("2024-04-30T00:00:00.000");
  });

  it("builds a stable dedupe key", () => {
    expect(socrataDedupeKey({ id: "abc123" })).toBe("socrata:abc123");
    expect(socrataDedupeKey({ ticket_created: "t", city: "Reno", state: "NV", zip: "89501" })).toBe(
      "socrata:t:Reno:NV:89501"
    );
  });
});

describe("ECFS filer rule (guardrail)", () => {
  it("classifies clear organizations as org", () => {
    for (const n of [
      "AT&T Services, Inc.",
      "Verizon Communications Inc.",
      "Smith & Associates LLP",
      "National Consumer Law Center",
      "Electronic Frontier Foundation",
      "Public Knowledge",
      "Office of the Attorney General",
    ]) {
      expect(classifyFiler(n).isOrg, n).toBe(true);
    }
  });

  it("treats private individuals as non-org, and never as org on a surname collision", () => {
    for (const n of ["John Smith", "Jane Q. Public", "Bob Lawson", "Maria Grouper", "Chris Law"]) {
      expect(classifyFiler(n).isOrg, n).toBe(false);
    }
  });

  it("stores the name only for orgs, and withholds it for individuals", () => {
    const items = parseEcfsFilings(ecfsFilings);
    expect(items.length).toBe(2);

    const org = items[0]!;
    const person = items[1]!;

    const orgExcerpt = buildFilingExcerpt(org, classifyFiler(org.filerName).isOrg, ["bill_credits"]);
    expect(orgExcerpt).toContain("National Consumer Law Center");

    const personExcerpt = buildFilingExcerpt(person, classifyFiler(person.filerName).isOrg, ["promotional_credit"]);
    expect(personExcerpt).toContain("name withheld");
    expect(personExcerpt).not.toContain("Jane");
    expect(personExcerpt).not.toContain("Public");
    // Also never leak the raw comment body for an individual.
    expect(personExcerpt).not.toContain("three months");
  });
});

describe("news radar", () => {
  it("parses GDELT articles and dates", () => {
    const arts = parseGdelt(gdelt);
    expect(arts.length).toBe(2);
    expect(arts[0]!.domain).toBe("example.com");
    expect(parseGdeltDate("20240501T120000Z")).toBe(Math.floor(Date.UTC(2024, 4, 1, 12, 0, 0) / 1000));
    expect(parseGdeltDate("bad")).toBe(null);
  });

  it("extracts a source label from a Google News title, else the host", () => {
    expect(newsSource("Headline here - Reuters", "https://news.google.com/x")).toBe("Reuters");
    expect(newsSource("No dash headline", "https://example.com/a")).toBe("example.com");
  });

  it("builds a scoped boolean query", () => {
    const q = buildNewsQuery();
    expect(q).toContain("bill credits");
    expect(q).toContain("Verizon");
  });
});

describe("http 429 Retry-After", () => {
  it("parses seconds and http-date", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    const now = Date.now();
    const inTen = new Date(now + 10_000).toUTCString();
    const ms = parseRetryAfter(inTen, now);
    expect(ms).toBeGreaterThan(8000);
    expect(ms).toBeLessThanOrEqual(11000);
    expect(parseRetryAfter(null)).toBe(null);
  });

  it("waits on a 429 then retries and succeeds", async () => {
    let calls = 0;
    const slept: number[] = [];
    const fakeFetch = async () => {
      calls++;
      if (calls === 1) return new Response("", { status: 429, headers: { "retry-after": "1" } });
      return new Response("ok", { status: 200 });
    };
    const res = await fetchWithRetry(
      "https://api.gdeltproject.org/x",
      {},
      { fetchImpl: fakeFetch, sleepImpl: async (ms) => { slept.push(ms); } }
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(slept).toEqual([1000]);
  });

  it("gives up after the retry budget and returns the last 429", async () => {
    const slept: number[] = [];
    const always429 = async () => new Response("", { status: 429, headers: { "retry-after": "1" } });
    const res = await fetchWithRetry(
      "https://x",
      {},
      { retries: 2, fetchImpl: always429, sleepImpl: async (ms) => { slept.push(ms); } }
    );
    expect(res.status).toBe(429);
    expect(slept.length).toBe(2);
  });
});

describe("taxonomy extensions", () => {
  it("matches issue terms and taxonomy presence", () => {
    expect(matchIssueTerms("they removed my promotional credit")).toContain("promotional_credit");
    expect(hasTaxonomyMatch("nothing relevant here")).toBe(false);
    expect(hasTaxonomyMatch("Verizon did it")).toBe(true);
  });

  it("exposes per-carrier promo names", () => {
    expect(promoNamesFor("tmobile")).toContain("keep and switch");
    expect(promoNamesFor("unknown")).toEqual([]);
  });
});
