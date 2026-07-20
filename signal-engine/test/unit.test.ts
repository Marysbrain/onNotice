import { describe, it, expect } from "vitest";
import { parseFeed, buildExcerpt } from "../src/lib/rss.js";
import { normalizeText, unifiedDiff } from "../src/lib/diff.js";
import { parseCsv } from "../src/processors/parse-file.js";
import { matchCarrier, matchArbRespondent } from "../src/lib/taxonomy.js";
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
});
