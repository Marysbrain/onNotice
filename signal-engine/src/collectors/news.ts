import type { Env } from "../env.js";
import { enabledSources, insertRecord, touchSource } from "../db/records.js";
import { parseFeed } from "../lib/rss.js";
import { matchCarrier } from "../lib/taxonomy.js";
import { fetchWithRetry, type FetchImpl, type SleepImpl } from "../lib/http.js";

// News radar. Discovery only. We store headline, source domain, date, and link.
// Never article bodies. Records are tagged with lead source ids so Track C
// treats them as leads, never as verified counts.
//
// Two backends:
//   Google News RSS  (kind 'news_rss')  polled gently
//   GDELT DOC 2.0    (kind 'news_api')  strictly paced, 429-aware (1 req / 5s)

const MAX_RECORDS_PER_RUN = 25;
const UA = "carriers-on-notice/0.1 (+contact@carriersonnotice.com)";

// One boolean query bundle across carriers and promo terms. Kept short so the
// query string stays small.
export function buildNewsQuery(): string {
  return '("bill credits" OR "trade-in credit" OR "promotional credit") (AT&T OR Verizon OR "T-Mobile")';
}

// Google News titles end with " - Publisher". Prefer that as the domain label,
// else fall back to the link host.
export function newsSource(title: string, link: string): string {
  const dash = title.lastIndexOf(" - ");
  if (dash > 0 && dash > title.length - 60) return title.slice(dash + 3).trim();
  try {
    return new URL(link).hostname;
  } catch {
    return "";
  }
}

export interface GdeltArticle {
  title: string;
  url: string;
  domain: string;
  seendate: string;
}

export function parseGdelt(json: unknown): GdeltArticle[] {
  const articles = (json as { articles?: unknown[] })?.articles;
  if (!Array.isArray(articles)) return [];
  const out: GdeltArticle[] = [];
  for (const a of articles) {
    const art = a as Record<string, unknown>;
    const url = String(art.url ?? "");
    if (!url) continue;
    out.push({
      title: String(art.title ?? ""),
      url,
      domain: String(art.domain ?? ""),
      seendate: String(art.seendate ?? ""),
    });
  }
  return out;
}

// GDELT seendate looks like 20240501T120000Z. Return epoch seconds or null.
export function parseGdeltDate(seendate: string): number | null {
  const m = seendate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export interface NewsDeps {
  fetchImpl?: FetchImpl;
  sleepImpl?: SleepImpl;
}

export async function collectNews(env: Env, deps: NewsDeps = {}): Promise<{ source: string; new: number }[]> {
  const out: { source: string; new: number }[] = [];
  const q = buildNewsQuery();
  const capture = Math.floor(Date.now() / 1000);

  // Google News RSS.
  for (const src of await enabledSources(env, "news_rss")) {
    if (!src.url) continue;
    let added = 0;
    try {
      const url = `${src.url}?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
      const res = await (deps.fetchImpl ?? ((u, i) => fetch(u, i)))(url, {
        headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml" },
      });
      if (res.ok) {
        const items = parseFeed(await res.text());
        for (const item of items.slice(0, MAX_RECORDS_PER_RUN)) {
          if (!item.link) continue;
          const domain = newsSource(item.title, item.link);
          const inserted = await insertRecord(env, {
            dedupeKey: `news:google:${item.link}`,
            sourceId: src.id,
            sourceUrl: item.link,
            captureDate: capture,
            recordDate: item.pubDate ? epochOrNull(item.pubDate) : null,
            excerpt: `${item.title} | ${domain}`.slice(0, 500),
            carrier: matchCarrier(item.title),
            vettingStatus: "single_source",
          });
          if (inserted) added++;
        }
        await touchSource(env, src.id);
      }
    } catch {
      // Drop this run.
    }
    out.push({ source: src.id, new: added });
  }

  // GDELT DOC 2.0. Paced and 429-aware.
  for (const src of await enabledSources(env, "news_api")) {
    if (!src.url) continue;
    let added = 0;
    try {
      const url = `${src.url}?query=${encodeURIComponent(q)}&mode=artlist&format=json&maxrecords=${MAX_RECORDS_PER_RUN}&sort=datedesc`;
      const res = await fetchWithRetry(
        url,
        { headers: { "User-Agent": UA, Accept: "application/json" } },
        { retries: 2, defaultDelayMs: 5000, fetchImpl: deps.fetchImpl, sleepImpl: deps.sleepImpl }
      );
      if (res.ok) {
        const articles = parseGdelt(await res.json());
        for (const art of articles) {
          const inserted = await insertRecord(env, {
            dedupeKey: `news:gdelt:${art.url}`,
            sourceId: src.id,
            sourceUrl: art.url,
            captureDate: capture,
            recordDate: parseGdeltDate(art.seendate),
            excerpt: `${art.title} | ${art.domain}`.slice(0, 500),
            carrier: matchCarrier(art.title),
            vettingStatus: "single_source",
          });
          if (inserted) added++;
        }
        await touchSource(env, src.id);
      }
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
