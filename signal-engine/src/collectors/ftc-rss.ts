import type { Env } from "../env.js";
import { parseFeed, buildExcerpt } from "../lib/rss.js";
import { enabledSources, insertRecord, touchSource } from "../db/records.js";
import { matchCarrier, isTelecomRelevant } from "../lib/taxonomy.js";

const UA = "carriers-on-notice/0.1 (+contact@athipp.com)";

// Poll the FTC feeds. Each item becomes a record. Dedupe by link. FTC releases
// are public-domain primary documents, so vetting_status is verified_primary.
// Carrier tagging here is a cheap first pass; Track C confirms it.
export async function collectFtcRss(env: Env): Promise<{ source: string; new: number }[]> {
  const sources = await enabledSources(env, "rss");
  const out: { source: string; new: number }[] = [];

  for (const src of sources) {
    if (!src.url) continue;
    let added = 0;
    try {
      const res = await fetch(src.url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" } });
      if (!res.ok) {
        out.push({ source: src.id, new: 0 });
        continue;
      }
      const xml = await res.text();
      const items = parseFeed(xml);
      const capture = Math.floor(Date.now() / 1000);

      for (const item of items) {
        if (!item.link) continue;
        // Same relevance gate as the backfill walker. The FTC publishes across
        // every industry; only telecom-relevant releases become records.
        if (!isTelecomRelevant(`${item.title} ${item.description}`)) continue;
        const excerpt = buildExcerpt(item);
        const carrier = matchCarrier(`${item.title} ${item.description}`);
        const inserted = await insertRecord(env, {
          dedupeKey: `ftc:${item.link}`,
          sourceId: src.id,
          sourceUrl: item.link,
          captureDate: capture,
          recordDate: parseDate(item.pubDate),
          excerpt,
          carrier,
          vettingStatus: "verified_primary",
        });
        if (inserted) added++;
      }
      await touchSource(env, src.id);
    } catch {
      // Drop this source for this run. Next cron retries.
    }
    out.push({ source: src.id, new: added });
  }
  return out;
}

function parseDate(s?: string): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}
