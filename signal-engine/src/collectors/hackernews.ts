import type { Env } from "../env.js";
import { enabledSources, insertRecord, touchSource } from "../db/records.js";
import { matchCarrier, hasTaxonomyMatch, searchPhrases } from "../lib/taxonomy.js";
import type { FetchImpl } from "../lib/http.js";

// Hacker News via the Algolia search API. Once daily per phrase bundle, stories
// and comments. Free, no key.
//
// PRIVACY RULE: we do not store the author username. We store the objectID (the
// item id, our re-resolution key for deletion honoring), the item permalink
// (which carries no username), the date, and a trimmed, HTML-stripped excerpt.

const UA = "carriers-on-notice/0.1 (+contact@athipp.com)";
const SEARCH = "https://hn.algolia.com/api/v1/search_by_date";
const PER_PHRASE = 25;
const MAX_RECORDS_PER_RUN = 100;

export interface HnItem {
  objectID: string;
  text: string;
  createdAt: number | null;
}

function stripHtml(s: string): string {
  // Decode entities first so encoded tags like &lt;b&gt; become real tags, then
  // strip tags. Decode &amp; last so we never double-decode. HN comment_text is
  // HTML with entity-encoded angle brackets, so order matters here.
  const decoded = s
    .replace(/&#x2F;/g, "/")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return decoded
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Parse Algolia hits. Excerpt is the title (stories) or comment text (comments),
// HTML-stripped. Author fields are ignored.
export function parseHnSearch(json: unknown): HnItem[] {
  const hits = (json as { hits?: unknown[] })?.hits;
  if (!Array.isArray(hits)) return [];
  const out: HnItem[] = [];
  for (const h of hits) {
    const hit = h as { objectID?: string; title?: unknown; comment_text?: unknown; story_text?: unknown; created_at_i?: unknown };
    if (!hit.objectID) continue;
    const raw =
      (typeof hit.title === "string" && hit.title) ||
      (typeof hit.comment_text === "string" && hit.comment_text) ||
      (typeof hit.story_text === "string" && hit.story_text) ||
      "";
    out.push({
      objectID: hit.objectID,
      text: stripHtml(raw),
      createdAt: typeof hit.created_at_i === "number" ? hit.created_at_i : null,
    });
  }
  return out;
}

export function hnPermalink(objectID: string): string {
  return `https://news.ycombinator.com/item?id=${objectID}`;
}

export async function collectHackerNews(
  env: Env,
  deps: { fetchImpl?: FetchImpl } = {}
): Promise<{ source: string; new: number }[]> {
  const doFetch = deps.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const sources = await enabledSources(env, "hn");
  const out: { source: string; new: number }[] = [];
  const phrases = searchPhrases();

  for (const src of sources) {
    let added = 0;
    const capture = Math.floor(Date.now() / 1000);
    try {
      for (const phrase of phrases) {
        if (added >= MAX_RECORDS_PER_RUN) break;
        // advancedSyntax makes the quoted phrase an exact-phrase match instead
        // of loose token matching, which returned unrelated posts (seen live).
        const url = `${SEARCH}?query=${encodeURIComponent(`"${phrase}"`)}&tags=(story,comment)&hitsPerPage=${PER_PHRASE}&advancedSyntax=true`;
        const res = await doFetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
        if (!res.ok) continue;
        const items = parseHnSearch(await res.json());
        for (const item of items) {
          if (added >= MAX_RECORDS_PER_RUN) break;
          if (!item.text) continue;
          // Registry rule: filter down to promo-credit topics before anything
          // becomes a record. A post with neither a carrier nor an issue term
          // is not a lead, whatever the search engine thought.
          if (!hasTaxonomyMatch(item.text)) continue;
          const inserted = await insertRecord(env, {
            dedupeKey: `hn:${item.objectID}`,
            sourceId: src.id,
            sourceUrl: hnPermalink(item.objectID),
            captureDate: capture,
            recordDate: item.createdAt,
            excerpt: item.text.slice(0, 300),
            carrier: matchCarrier(item.text),
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
