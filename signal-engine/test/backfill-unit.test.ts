import { describe, it, expect } from "vitest";
import { addMonths, currentMonth, monthStartISO, monthEndISO } from "../src/lib/months.js";
import { buildFccAggQuery } from "../src/backfill/fcc-aggregate-backfill.js";
import { buildCourtListenerUrl, parseCourtListener, parseNextUrl, courtlistenerQueries } from "../src/backfill/courtlistener-backfill.js";
import { buildFtcListUrl, parseFtcListing } from "../src/backfill/ftc-backfill.js";
import { parseCdx, timestampToEpoch, buildSnapshotDiffs, snapshotUrl } from "../src/backfill/wayback-backfill.js";
import { rankHotspots } from "../src/publish/hotspots.js";
import ftcHtml from "./fixtures/ftc-listing.html?raw";

describe("month cursor", () => {
  it("adds months across year boundaries", () => {
    expect(addMonths("2014-11", 1)).toBe("2014-12");
    expect(addMonths("2014-12", 1)).toBe("2015-01");
    expect(addMonths("2015-01", -2)).toBe("2014-11");
  });
  it("formats month window boundaries", () => {
    expect(monthStartISO("2015-03")).toBe("2015-03-01T00:00:00.000");
    expect(monthEndISO("2015-03")).toBe("2015-04-01T00:00:00.000");
  });
  it("current month is YYYY-MM", () => {
    expect(currentMonth(new Date(Date.UTC(2026, 6, 20)))).toBe("2026-07");
  });
});

describe("FCC SoQL query", () => {
  it("uses date_trunc_ym, groups, and filters the month window", () => {
    // URLSearchParams encodes spaces as '+', which decodeURIComponent keeps.
    const decoded = decodeURIComponent(buildFccAggQuery("https://x/y.json", "state", "2015-03-01T00:00:00.000", "2015-04-01T00:00:00.000", 100)).replace(/\+/g, " ");
    expect(decoded).toContain("date_trunc_ym(to_floating_timestamp(ticket_created,'UTC'))");
    expect(decoded).toContain("issue_type='Phone'");
    expect(decoded).toContain("ticket_created >= '2015-03-01T00:00:00.000'");
    expect(decoded).toContain("ticket_created < '2015-04-01T00:00:00.000'");
    expect(decoded).toContain("$group=state, date_trunc_ym(to_floating_timestamp(ticket_created,'UTC'))");
  });
});

describe("CourtListener", () => {
  it("builds queries from carriers and phrases", () => {
    const qs = courtlistenerQueries();
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.some((q) => q.includes("AT&T"))).toBe(true);
  });
  it("builds a search url with type=r", () => {
    expect(buildCourtListenerUrl("https://cl/api", '"AT&T" "bill credits"')).toContain("type=r");
  });
  it("parses v4 docket rows via docket_absolute_url", () => {
    // Live v4 shape: absolute_url lives on nested recap_documents, not the row.
    const items = parseCourtListener({
      results: [
        {
          caseName: "SULLIVAN v. US CELLULAR",
          court: "District Court, D. Maine",
          dateFiled: "2026-01-16",
          docketNumber: "1:26-cv-00028",
          docket_absolute_url: "/docket/72162640/sullivan-v-us-cellular/",
          recap_documents: [{ absolute_url: "/docket/72162640/1/1/sullivan-v-us-cellular/" }],
        },
        { caseName: "No Url Case" },
      ],
    });
    expect(items.length).toBe(1);
    expect(items[0]!.url).toBe("https://www.courtlistener.com/docket/72162640/sullivan-v-us-cellular/");
    expect(items[0]!.docketNumber).toBe("1:26-cv-00028");
  });
  it("parses dockets via the absolute_url fallback", () => {
    const items = parseCourtListener({
      results: [
        { caseName: "Doe v. AT&T Mobility", court: "cacd", dateFiled: "2021-05-01", docketNumber: "2:21-cv-1", absolute_url: "/docket/1/doe-v-att/" },
      ],
    });
    expect(items.length).toBe(1);
    expect(items[0]!.url).toBe("https://www.courtlistener.com/docket/1/doe-v-att/");
  });
  it("follows only courtlistener-hosted next cursors", () => {
    expect(parseNextUrl({ next: "https://www.courtlistener.com/api/rest/v4/search/?cursor=abc" })).toBe(
      "https://www.courtlistener.com/api/rest/v4/search/?cursor=abc"
    );
    expect(parseNextUrl({ next: "https://evil.example/steal" })).toBe(null);
    expect(parseNextUrl({ next: null })).toBe(null);
  });
});

describe("FTC listing", () => {
  it("paginates and reads dates from the URL path", () => {
    expect(buildFtcListUrl("https://ftc/pr", 0)).toBe("https://ftc/pr");
    expect(buildFtcListUrl("https://ftc/pr", 3)).toBe("https://ftc/pr?page=3");
    const items = parseFtcListing(ftcHtml);
    expect(items.length).toBe(3); // three press releases, the contact link is ignored
    const wc = items.find((i) => i.url.includes("wireless-carrier"));
    expect(wc!.year).toBe(2019);
    expect(wc!.month).toBe(7);
  });
});

describe("Wayback CDX", () => {
  it("parses CDX json, skipping the header row", () => {
    const caps = parseCdx([
      ["timestamp", "original", "digest", "statuscode"],
      ["20190601120000", "https://att.com/promo", "DIGESTA", "200"],
      ["20200115090000", "https://att.com/promo", "DIGESTB", "200"],
    ]);
    expect(caps.length).toBe(2);
    expect(caps[0]!.digest).toBe("DIGESTA");
    expect(snapshotUrl(caps[0]!.timestamp, caps[0]!.original)).toBe("https://web.archive.org/web/20190601120000/https://att.com/promo");
  });
  it("converts a CDX timestamp to epoch seconds", () => {
    expect(timestampToEpoch("20190601120000")).toBe(Math.floor(Date.UTC(2019, 5, 1, 12, 0, 0) / 1000));
  });
  it("chains diffs only where the hash changed", () => {
    const steps = buildSnapshotDiffs([
      { hash: "a", text: "line one\nold" },
      { hash: "a", text: "line one\nold" },
      { hash: "b", text: "line one\nnew" },
    ]);
    expect(steps.length).toBe(1);
    expect(steps[0]!.from_hash).toBe("a");
    expect(steps[0]!.to_hash).toBe("b");
    expect(steps[0]!.diff).toContain("- old");
    expect(steps[0]!.diff).toContain("+ new");
  });
});

describe("hotspot ranking", () => {
  it("ranks by complaint volume boosted by vetted records, normalized to the top", () => {
    const hs = rankHotspots(
      [
        { state: "CA", fccCount: 5000, recordCount: 0 },
        { state: "NV", fccCount: 1000, recordCount: 2 },
      ],
      10
    );
    expect(hs[0]!.state).toBe("CA");
    expect(hs[0]!.intensity).toBe(1);
    expect(hs[1]!.state).toBe("NV");
    expect(hs[1]!.intensity).toBeLessThan(1);
    expect(hs[1]!.basis).toContain("vetted report");
  });
});
