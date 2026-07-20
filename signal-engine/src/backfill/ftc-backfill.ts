import type { Env } from "../env.js";
import type { FetchImpl } from "../lib/http.js";
import { insertRecord } from "../db/records.js";
import { getConfigString } from "../lib/config.js";
import { matchCarrier, hasTaxonomyMatch } from "../lib/taxonomy.js";

// FTC press release history walker. Pages backward through the press-release
// listing, one page per run, terminating at a configurable earliest date
// (default 2015-01-01). Records get record_date from the item date so history
// lands in the right months.
//
// FTC press-release URLs embed the year and month, for example
//   /news-events/news/press-releases/2019/07/some-slug
// so we read the date straight from the URL, which is far more robust than
// scraping a date element. The listing markup itself may change; the anchor
// pattern is the assumption to confirm on first real run.

const BASE = "https://www.ftc.gov/news-events/news/press-releases";
const EARLIEST_DEFAULT = "2015-01-01";
const TELECOM = ["wireless", "telecom", "mobile", "carrier", "broadband", "cellular", "cell phone", "5g", "internet service"];

export interface FtcItem {
  url: string;
  year: number;
  month: number;
  title: string;
}

export function buildFtcListUrl(base: string, page: number): string {
  return page > 0 ? `${base}?page=${page}` : base;
}

// Extract press-release items from a listing page. Date comes from the URL path.
export function parseFtcListing(html: string, baseUrl = "https://www.ftc.gov"): FtcItem[] {
  const items: FtcItem[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]+href="([^"]*\/news-events\/news\/press-releases\/(\d{4})\/(\d{2})\/[^"?#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1]!;
    const url = href.startsWith("http") ? href : `${baseUrl}${href}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = m[4]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!title) continue;
    items.push({ url, year: Number(m[2]), month: Number(m[3]), title });
  }
  return items;
}

function ymNumber(year: number, month: number): number {
  return year * 100 + month;
}

export async function runFtcBackfill(
  env: Env,
  deps: { fetchImpl?: FetchImpl } = {}
): Promise<{ page: number; inserted: number; more: boolean; cursorKey: string }> {
  const doFetch = deps.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const earliest = await getConfigString(env, "FTC_BACKFILL_EARLIEST", EARLIEST_DEFAULT);
  const [ey, em] = earliest.split("-").map(Number);
  const earliestYm = ymNumber(ey!, em!);

  const raw = await env.CONFIG.get("cursor:ftc_backfill_page");
  const page = raw ? Number(raw) : 0;

  let items: FtcItem[] = [];
  try {
    const res = await doFetch(buildFtcListUrl(BASE, page), {
      headers: { "User-Agent": "carriers-on-notice/0.1 (+contact@athipp.com)", Accept: "text/html" },
    });
    if (res.ok) items = parseFtcListing(await res.text());
  } catch {
    items = [];
  }

  if (items.length === 0) {
    return { page, inserted: 0, more: false, cursorKey: String(page) };
  }

  const capture = Math.floor(Date.now() / 1000);
  let inserted = 0;
  let reachedEarliest = false;

  for (const item of items) {
    if (ymNumber(item.year, item.month) < earliestYm) {
      reachedEarliest = true;
      continue;
    }
    const isTelecom = hasTaxonomyMatch(item.title) || TELECOM.some((t) => item.title.toLowerCase().includes(t));
    if (!isTelecom) continue;

    const recordDate = Math.floor(Date.UTC(item.year, item.month - 1, 1) / 1000);
    const ok = await insertRecord(env, {
      dedupeKey: `ftc:${item.url}`,
      sourceId: "ftc_backfill",
      sourceUrl: item.url,
      captureDate: capture,
      recordDate,
      excerpt: item.title.slice(0, 500),
      carrier: matchCarrier(item.title),
      vettingStatus: "verified_primary",
    });
    if (ok) inserted++;
  }

  const nextPage = page + 1;
  await env.CONFIG.put("cursor:ftc_backfill_page", String(nextPage));
  const more = !reachedEarliest;
  return { page, inserted, more, cursorKey: String(nextPage) };
}
