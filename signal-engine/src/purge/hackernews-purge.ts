import type { Env } from "../env.js";
import { dueForRecheck, purgeKeys, markChecked } from "../db/social.js";
import type { FetchImpl } from "../lib/http.js";

// Hacker News deletion honoring. Same weekly re-check pattern as Bluesky. The
// Algolia items endpoint is one item per call, so this sweep is smaller.
//
// WEEKLY GUARANTEE (the math):
//   items endpoint = 1 request per id. We check up to BATCH=20 ids per sweep.
//   The sweep runs on the hourly trigger: 168 sweeps/week.
//   Coverage = 20 * 168 = 3,360 records re-checked per week, oldest-checked
//   first, so every stored HN record is re-fetched at least weekly while the
//   stored count stays under ~3,360. Subrequest cap is 50/invocation, so BATCH
//   can rise toward 40 if volume grows before a design change is needed.
//
// Purged means deleted from D1, not flagged.

const BATCH = 20;
const SOURCE_IDS = ["hackernews"];
const UA = "carriers-on-notice/0.1 (+contact@athipp.com)";
const ITEM = "https://hn.algolia.com/api/v1/items";

// Decide from a fetch outcome whether an HN item is gone. 404 means removed.
// A body with deleted=true means removed. Anything else is treated as present.
// Unknown/ambiguous stays present, so we never purge on doubt.
export function hnItemGone(status: number, body: unknown): boolean {
  if (status === 404) return true;
  if (status !== 200) return false;
  const b = body as { deleted?: unknown } | null;
  return b?.deleted === true;
}

export async function purgeHackerNews(
  env: Env,
  deps: { fetchImpl?: FetchImpl } = {}
): Promise<{ checked: number; purged: number }> {
  const doFetch = deps.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const due = await dueForRecheck(env, SOURCE_IDS, BATCH);
  if (due.length === 0) return { checked: 0, purged: 0 };

  const checked: string[] = [];
  const gone: string[] = [];
  for (const row of due) {
    const objectID = row.dedupe_key.replace(/^hn:/, "");
    let status: number;
    let body: unknown = null;
    try {
      const res = await doFetch(`${ITEM}/${encodeURIComponent(objectID)}`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      status = res.status;
      if (status === 200) body = await res.json().catch(() => null);
    } catch {
      continue; // transient failure: not checked, not purged
    }
    checked.push(row.dedupe_key);
    if (hnItemGone(status, body)) gone.push(row.dedupe_key);
  }

  const survivors = checked.filter((k) => !gone.includes(k));
  const purged = await purgeKeys(env, gone);
  await markChecked(env, survivors, Math.floor(Date.now() / 1000));
  return { checked: checked.length, purged };
}
