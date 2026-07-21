import type { Env } from "../env.js";
import { dueForRecheck, purgeKeys, markChecked } from "../db/social.js";
import type { FetchImpl } from "../lib/http.js";

// Bluesky deletion honoring. A firehose consumer does not fit cron-driven free
// Workers, so this is the honest alternative: a scheduled sweep that re-resolves
// stored posts in batches via app.bsky.feed.getPosts (25 URIs per call) and
// hard-deletes any record whose post no longer resolves (deleted or taken down).
//
// WEEKLY GUARANTEE (the math):
//   getPosts takes 25 URIs/call. We check up to BATCH=50 URIs per sweep (2 calls).
//   The purge sweep runs on the hourly trigger: 24/day * 7 = 168 sweeps/week.
//   Coverage = 50 * 168 = 8,400 records re-checked per week. Records are picked
//   oldest-checked first, so every stored Bluesky record is re-resolved at least
//   weekly as long as the stored count stays under ~8,400. At once-daily
//   collection of a few phrase bundles that is a wide margin. If volume ever
//   approaches it, raise BATCH (subrequest cap is 50/invocation, so up to 25
//   calls = 625 URIs/sweep is available before needing a design change).
//
// Purged means deleted from D1, not flagged.

const BATCH = 50;
const CHUNK = 25; // getPosts hard limit per call
const SOURCE_IDS = ["bluesky"];
const UA = "carriers-on-notice/0.1 (+contact@carriersonnotice.com)";
const GET_POSTS = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts";

// URIs present in a getPosts response. Only these still exist.
export function parseResolvedUris(json: unknown): string[] {
  const posts = (json as { posts?: unknown[] })?.posts;
  if (!Array.isArray(posts)) return [];
  return posts.map((p) => (p as { uri?: string }).uri).filter((u): u is string => Boolean(u));
}

// Of the URIs we actually checked, which are gone (not in the resolved set).
export function goneUris(checked: string[], resolved: string[]): string[] {
  const alive = new Set(resolved);
  return checked.filter((u) => !alive.has(u));
}

export async function purgeBluesky(
  env: Env,
  deps: { fetchImpl?: FetchImpl } = {}
): Promise<{ checked: number; purged: number }> {
  const doFetch = deps.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const due = await dueForRecheck(env, SOURCE_IDS, BATCH);
  if (due.length === 0) return { checked: 0, purged: 0 };
  const uris = due.map((d) => d.dedupe_key);

  const checked: string[] = [];
  const resolved: string[] = [];
  for (let i = 0; i < uris.length; i += CHUNK) {
    const group = uris.slice(i, i + CHUNK);
    const qs = group.map((u) => `uris=${encodeURIComponent(u)}`).join("&");
    let res: Response;
    try {
      res = await doFetch(`${GET_POSTS}?${qs}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
    } catch {
      continue; // transient failure: do not treat this group as checked
    }
    if (!res.ok) continue; // do not purge on a bad response
    checked.push(...group);
    resolved.push(...parseResolvedUris(await res.json()));
  }

  const gone = goneUris(checked, resolved);
  const survivors = checked.filter((u) => !gone.includes(u));
  const purged = await purgeKeys(env, gone);
  await markChecked(env, survivors, Math.floor(Date.now() / 1000));
  return { checked: checked.length, purged };
}
