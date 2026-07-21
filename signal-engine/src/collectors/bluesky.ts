import type { Env } from "../env.js";
import { enabledSources, insertRecord, touchSource } from "../db/records.js";
import { matchCarrier, hasTaxonomyMatch, searchPhrases } from "../lib/taxonomy.js";
import type { FetchImpl } from "../lib/http.js";

// Bluesky public search. Unauthenticated read. Once daily per phrase bundle.
//
// PRIVACY RULE: we store the post AT-URI (which is the canonical post id and the
// key we re-resolve for deletion honoring) and nothing about the author. We do
// not read or store the handle, display name, or DID. The AT-URI necessarily
// contains the author DID; that is the one place it lives. We do not derive or
// store a bsky.app/profile/<did> permalink, so nothing copies the DID into a
// second field. Track E builds the human link on demand with blueskyPermalink().

const UA = "carriers-on-notice/0.1 (+contact@athipp.com)";
const SEARCH = "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts";
const PER_PHRASE = 25;
const MAX_RECORDS_PER_RUN = 100;

export interface BskyItem {
  uri: string;
  text: string;
  createdAt: string;
}

// Parse searchPosts output. Deliberately ignores author fields.
export function parseBlueskySearch(json: unknown): BskyItem[] {
  const posts = (json as { posts?: unknown[] })?.posts;
  if (!Array.isArray(posts)) return [];
  const out: BskyItem[] = [];
  for (const p of posts) {
    const post = p as { uri?: string; record?: { text?: unknown; createdAt?: unknown } };
    if (!post.uri) continue;
    const rec = post.record ?? {};
    out.push({
      uri: post.uri,
      text: typeof rec.text === "string" ? rec.text : "",
      createdAt: typeof rec.createdAt === "string" ? rec.createdAt : "",
    });
  }
  return out;
}

// Derive the human permalink from an AT-URI. Display-time only, for Track E.
// Not stored, on purpose: the DID stays inside the canonical AT-URI.
export function blueskyPermalink(uri: string): string | null {
  const m = uri.match(/^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
}

export async function collectBluesky(
  env: Env,
  deps: { fetchImpl?: FetchImpl } = {}
): Promise<{ source: string; new: number }[]> {
  const doFetch = deps.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const sources = await enabledSources(env, "bsky");
  const out: { source: string; new: number }[] = [];
  const phrases = searchPhrases();

  for (const src of sources) {
    let added = 0;
    const capture = Math.floor(Date.now() / 1000);
    try {
      for (const phrase of phrases) {
        if (added >= MAX_RECORDS_PER_RUN) break;
        const url = `${SEARCH}?q=${encodeURIComponent(phrase)}&limit=${PER_PHRASE}`;
        const res = await doFetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
        if (!res.ok) continue;
        const items = parseBlueskySearch(await res.json());
        for (const item of items) {
          if (added >= MAX_RECORDS_PER_RUN) break;
          // Registry rule: only carrier or promo-credit-topic posts become
          // records, whatever the search returned.
          if (!hasTaxonomyMatch(item.text)) continue;
          const inserted = await insertRecord(env, {
            // AT-URI is both the dedupe key and the stored source pointer.
            dedupeKey: item.uri,
            sourceId: src.id,
            sourceUrl: item.uri,
            captureDate: capture,
            recordDate: item.createdAt ? epochOrNull(item.createdAt) : null,
            excerpt: item.text.slice(0, 300),
            carrier: matchCarrier(item.text),
            // Lead / aggregate-count material only.
            vettingStatus: "single_source",
          });
          if (inserted) added++;
        }
      }
      await touchSource(env, src.id);
    } catch {
      // Drop this run.
    }
    out.push({ source: src.id, new: added });
  }
  return out;
}

function epochOrNull(s: string): number | null {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}
