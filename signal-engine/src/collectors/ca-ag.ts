import type { Env } from "../env.js";
import { parseFeed, buildExcerpt } from "../lib/rss.js";
import { enabledSources, insertRecord, touchSource } from "../db/records.js";
import { matchCarrier, hasTaxonomyMatch } from "../lib/taxonomy.js";

const UA = "carriers-on-notice/0.1 (+contact@athipp.com)";

// California AG news feed. Same shape as the FTC RSS collector, but we do not
// store every item. AG news covers everything the office does, so only items
// that match the taxonomy (a carrier or a promo-credit term) become records.
// We read from source kind 'ag_rss' so the FTC collector (kind 'rss') never
// picks these up and blanket-stores them.
export async function collectCaAg(env: Env): Promise<{ source: string; scanned: number; new: number }[]> {
  const sources = await enabledSources(env, "ag_rss");
  const out: { source: string; scanned: number; new: number }[] = [];

  for (const src of sources) {
    if (!src.url) continue;
    let added = 0;
    let scanned = 0;
    try {
      const res = await fetch(src.url, {
        headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" },
      });
      if (!res.ok) {
        out.push({ source: src.id, scanned: 0, new: 0 });
        continue;
      }
      const items = parseFeed(await res.text());
      const capture = Math.floor(Date.now() / 1000);

      for (const item of items) {
        scanned++;
        if (!item.link) continue;
        const text = `${item.title} ${item.description}`;
        if (!hasTaxonomyMatch(text)) continue;
        const inserted = await insertRecord(env, {
          dedupeKey: `caag:${item.link}`,
          sourceId: src.id,
          sourceUrl: item.link,
          captureDate: capture,
          recordDate: parseDate(item.pubDate),
          excerpt: buildExcerpt(item),
          carrier: matchCarrier(text),
          // State AG enforcement is a primary source.
          vettingStatus: "verified_primary",
        });
        if (inserted) added++;
      }
      await touchSource(env, src.id);
    } catch {
      // Drop for this run. Next cron retries.
    }
    out.push({ source: src.id, scanned, new: added });
  }
  return out;
}

function parseDate(s?: string): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}
