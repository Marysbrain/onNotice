import { describe, it, expect } from "vitest";
import { parseBlueskySearch, blueskyPermalink } from "../src/collectors/bluesky.js";
import { parseHnSearch, hnPermalink } from "../src/collectors/hackernews.js";
import { parseResolvedUris, goneUris } from "../src/purge/bluesky-purge.js";
import { hnItemGone } from "../src/purge/hackernews-purge.js";
import bsky from "./fixtures/bsky-search.json";
import hn from "./fixtures/hn-search.json";

describe("Bluesky parse", () => {
  it("extracts uri, text, createdAt and nothing about the author", () => {
    const items = parseBlueskySearch(bsky);
    expect(items.length).toBe(2);
    expect(items[0]!.uri).toBe("at://did:plc:abc123/app.bsky.feed.post/rkey1");
    expect(items[0]!.text).toContain("bill credits");
    expect(items[0]!.createdAt).toBe("2024-05-01T12:00:00Z");
    // The parsed item type carries no author field at all.
    expect(JSON.stringify(items)).not.toContain("victim.bsky.social");
    expect(JSON.stringify(items)).not.toContain("Jane Doe");
  });

  it("derives a permalink from an AT-URI, for display only", () => {
    expect(blueskyPermalink("at://did:plc:abc123/app.bsky.feed.post/rkey1")).toBe(
      "https://bsky.app/profile/did:plc:abc123/post/rkey1"
    );
    expect(blueskyPermalink("not-an-at-uri")).toBe(null);
  });
});

describe("Hacker News parse", () => {
  it("uses title or comment text, strips HTML, ignores author", () => {
    const items = parseHnSearch(hn);
    expect(items.length).toBe(2);
    expect(items[0]!.text).toContain("promotional credit");
    // HTML entities decoded and tags removed.
    expect(items[1]!.text).toContain("bill credits");
    expect(items[1]!.text).not.toContain("<b>");
    expect(JSON.stringify(items)).not.toContain("secret");
  });

  it("builds an item permalink with no username", () => {
    expect(hnPermalink("40123456")).toBe("https://news.ycombinator.com/item?id=40123456");
  });
});

describe("Bluesky purge helpers", () => {
  it("reads resolved uris from getPosts output", () => {
    expect(parseResolvedUris({ posts: [{ uri: "a" }, { uri: "b" }] })).toEqual(["a", "b"]);
    expect(parseResolvedUris({})).toEqual([]);
  });

  it("computes the gone set as checked minus resolved", () => {
    expect(goneUris(["a", "b", "c"], ["a", "c"])).toEqual(["b"]);
    expect(goneUris(["a"], ["a"])).toEqual([]);
  });
});

describe("HN gone rule", () => {
  it("treats 404 and deleted=true as gone, everything else as present", () => {
    expect(hnItemGone(404, null)).toBe(true);
    expect(hnItemGone(200, { deleted: true })).toBe(true);
    expect(hnItemGone(200, { objectID: "x" })).toBe(false);
    // Never purge on an ambiguous or transient status.
    expect(hnItemGone(500, null)).toBe(false);
    expect(hnItemGone(429, null)).toBe(false);
  });
});
