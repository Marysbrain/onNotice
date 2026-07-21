import { describe, it, expect } from "vitest";
import { parseFeed, buildExcerpt } from "../src/lib/rss.js";
import { normalizeText, unifiedDiff } from "../src/lib/diff.js";
import { parseCsv, findColumn, parseArbDate, RESPONDENT_COLUMNS, CASE_ID_COLUMNS, FILING_DATE_COLUMNS } from "../src/processors/parse-file.js";
import { matchCarrier, matchArbRespondent, isTelecomRelevant } from "../src/lib/taxonomy.js";
import ftcFeed from "./fixtures/ftc-feed.xml?raw";

describe("rss parse", () => {
  it("extracts items with title, link, description", () => {
    const items = parseFeed(ftcFeed);
    expect(items.length).toBe(3);
    expect(items[0]!.title).toContain("Wireless Carrier");
    expect(items[0]!.link).toBe("https://www.ftc.gov/news-events/news/press-releases/2026/07/ftc-action-carrier");
    expect(items[0]!.description).toContain("trade-in credit");
    // CDATA and tags stripped.
    expect(items[0]!.description).not.toContain("<b>");
  });

  it("builds an excerpt from title + description", () => {
    const items = parseFeed(ftcFeed);
    const ex = buildExcerpt(items[0]!);
    expect(ex.startsWith(items[0]!.title)).toBe(true);
    expect(ex).toContain("trade-in credit");
  });

  it("strips tags that arrive HTML-encoded, the live FTC feed shape", () => {
    const xml = `<rss><channel><item><title>Test</title><link>https://x</link><description>&lt;p&gt;The Commission &lt;a href="https://www.ftc.gov/x"&gt;announced&lt;/a&gt; an action.&lt;/p&gt;</description></item></channel></rss>`;
    const items = parseFeed(xml);
    expect(items[0]!.description).toBe("The Commission announced an action.");
    expect(items[0]!.description).not.toContain("<p>");
    expect(items[0]!.description).not.toContain("href");
  });
});

describe("dedupe key from feed links", () => {
  it("two items sharing a link collapse to one unique key", () => {
    const items = parseFeed(ftcFeed);
    const keys = new Set(items.map((i) => `ftc:${i.link}`));
    // 3 items, 2 unique links.
    expect(keys.size).toBe(2);
  });
});

describe("diff detection", () => {
  it("no diff when normalized text is unchanged", async () => {
    const a = normalizeText("<html><body><p>36 months of bill credits</p></body></html>");
    const b = normalizeText("<html>\n<body>\n  <p>36 months of bill credits</p>\n</body></html>");
    expect(a).toBe(b);
  });

  it("produces a unified diff when a line changes", () => {
    const oldT = "line one\n36 months\nline three";
    const newT = "line one\n24 months\nline three";
    const d = unifiedDiff(oldT, newT);
    expect(d).toContain("- 36 months");
    expect(d).toContain("+ 24 months");
    expect(d).toContain("  line one");
  });
});

describe("csv parse", () => {
  it("handles quotes, commas, and newlines", () => {
    const csv = 'Respondent,Amount\n"AT&T Mobility, LLC",100\n"Verizon Wireless","1,200"';
    const rows = parseCsv(csv);
    expect(rows.length).toBe(3);
    expect(rows[1]![0]).toBe("AT&T Mobility, LLC");
    expect(rows[2]![1]).toBe("1,200");
  });
});

describe("arbitration file columns", () => {
  // The real AAA Q1 2026 header row, abbreviated to the collision-prone part.
  const aaaHeader = [
    "nonconsumer", "initiating party", "source of authority", "typedispute",
    "dispute subtype", "salary range", "prevailing party", "filing date",
    "closedate", "type of disposition", "claim amt business", "claim amt consumer",
    "total fee", "case id", "arbitrator name",
  ];
  it("finds the AAA Nonconsumer column, not Claim Amt Business or Arbitrator Name", () => {
    expect(findColumn(aaaHeader, RESPONDENT_COLUMNS)).toBe(0);
    expect(findColumn(aaaHeader, CASE_ID_COLUMNS)).toBe(13);
    expect(findColumn(aaaHeader, FILING_DATE_COLUMNS)).toBe(7);
  });
  it("parses AAA DD-MON-YY filing dates", () => {
    expect(parseArbDate("02-JUN-21")).toBe(Math.floor(Date.UTC(2021, 5, 2) / 1000));
    expect(parseArbDate("20-NOV-19")).toBe(Math.floor(Date.UTC(2019, 10, 20) / 1000));
    expect(parseArbDate("2024-03-05")).toBe(Math.floor(Date.UTC(2024, 2, 5) / 1000));
    expect(parseArbDate("")).toBe(null);
    expect(parseArbDate("not a date")).toBe(null);
  });
});

describe("taxonomy matching", () => {
  it("matches carrier marketing patterns", () => {
    expect(matchCarrier("T-Mobile keep and switch offer")).toBe("tmobile");
    expect(matchCarrier("nothing here")).toBe(null);
  });

  it("matches arbitration respondent names", () => {
    expect(matchArbRespondent("AT&T Mobility LLC")).toBe("att");
    expect(matchArbRespondent("Cellco Partnership d/b/a Verizon Wireless")).toBe("verizon");
    expect(matchArbRespondent("Acme Widgets Inc")).toBe(null);
  });

  it("requires word boundaries, not raw substrings", () => {
    // Production false positive: "against Mobilewalla" contains "t mobile".
    expect(matchCarrier("FTC Takes Action Against Mobilewalla for Selling Location Data")).toBe(null);
    expect(matchCarrier("the metropolitan area")).toBe(null);
    expect(matchCarrier("a clearly visible defect")).toBe(null);
    expect(matchCarrier("cricket match results")).toBe(null);
    expect(matchArbRespondent("Metropolitan Life Insurance")).toBe(null);
  });

  it("gates telecom relevance on whole words", () => {
    expect(isTelecomRelevant("FTC Takes Action Against Mobilewalla")).toBe(false);
    expect(isTelecomRelevant("FTC Fines Wireless Carrier Over Billing")).toBe(true);
    expect(isTelecomRelevant("Order covers mobile broadband providers")).toBe(true);
    expect(isTelecomRelevant("Mortgage relief scheme returns funds")).toBe(false);
  });

  it("still matches real carrier mentions at boundaries", () => {
    expect(matchCarrier("Switching to T Mobile next month")).toBe("tmobile");
    expect(matchCarrier("AT&T's trade-in fine print")).toBe("att");
    expect(matchCarrier("Visible by Verizon promo")).toBe("verizon");
    expect(matchCarrier("Metro by T-Mobile store")).toBe("tmobile");
    expect(matchArbRespondent("Cricket Wireless, LLC")).toBe("att");
  });
});
