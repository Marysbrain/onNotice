import type { Env } from "../env.js";
import { enabledSources, touchSource } from "../db/records.js";
import { sha256Hex } from "../lib/hash.js";
import { normalizeText, unifiedDiff } from "../lib/diff.js";
import { saveToWayback } from "../lib/wayback.js";

const UA = "carriers-on-notice/0.1 (+contact@carriersonnotice.com)";

// Fallback for targets behind a bot wall (T-Mobile's Akamai returns 403 to the
// honest UA). We identify honestly first and only present browser headers on a
// block, and only for robots.txt-allowed paths; disallowed paths are disabled
// in sources and covered by Wayback captures instead.
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

interface PriorSnap {
  id: number;
  content_hash: string;
  r2_key: string;
}

// Snapshot each terms target: fetch, store raw HTML to R2, hash normalized text,
// write a snapshot row, and write a diff row when the hash changed. Also fire a
// Wayback save. All small per-page work, inside the free CPU budget.
export async function collectTerms(env: Env): Promise<{ target: string; changed: boolean; captured: boolean }[]> {
  const targets = await enabledSources(env, "terms_page");
  const out: { target: string; changed: boolean; captured: boolean }[] = [];

  for (const src of targets) {
    if (!src.url || src.url.includes("REPLACE_WITH_REAL_TERMS_URL")) {
      // Placeholder target. Skip until a real URL is seeded (see README).
      out.push({ target: src.id, changed: false, captured: false });
      continue;
    }
    try {
      out.push(await snapshotOne(env, src.id, src.url));
      await touchSource(env, src.id);
    } catch {
      out.push({ target: src.id, changed: false, captured: false });
    }
  }
  return out;
}

async function snapshotOne(env: Env, target: string, url: string) {
  let res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (res.status === 403 || res.status === 429) {
    res = await fetch(url, { headers: BROWSER_HEADERS });
  }
  if (!res.ok) return { target, changed: false, captured: false };
  const html = await res.text();

  const normalized = normalizeText(html);
  const hash = await sha256Hex(normalized);
  const capturedAt = Math.floor(Date.now() / 1000);

  const prior = await env.DB.prepare(
    `SELECT id, content_hash, r2_key FROM terms_snapshots
      WHERE target = ?1 ORDER BY captured_at DESC LIMIT 1`
  )
    .bind(target)
    .first<PriorSnap>();

  // Unchanged: nothing new to store. Saves R2 writes and rows.
  if (prior && prior.content_hash === hash) {
    return { target, changed: false, captured: false };
  }

  const r2Key = `terms/${target}/${capturedAt}.html`;
  await env.RAW.put(r2Key, html, {
    httpMetadata: { contentType: "text/html" },
    customMetadata: { target, url, capturedAt: String(capturedAt) },
  });

  const wb = await saveToWayback(env, url);

  const snapId = await insertSnapshot(env, {
    target,
    url,
    r2Key,
    hash,
    archiveUrl: wb.archiveUrl ?? null,
    capturedAt,
  });

  // First-ever snapshot: no diff to write.
  if (!prior) return { target, changed: true, captured: true };

  const oldHtml = (await env.RAW.get(prior.r2_key).then((o) => o?.text())) ?? "";
  const diff = unifiedDiff(normalizeText(oldHtml), normalized, prior.content_hash, hash);
  await env.DB.prepare(
    `INSERT INTO terms_diffs (target, from_snap_id, to_snap_id, from_hash, to_hash, diff)
     VALUES (?1,?2,?3,?4,?5,?6)`
  )
    .bind(target, prior.id, snapId, prior.content_hash, hash, diff)
    .run();

  return { target, changed: true, captured: true };
}

async function insertSnapshot(
  env: Env,
  s: { target: string; url: string; r2Key: string; hash: string; archiveUrl: string | null; capturedAt: number }
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO terms_snapshots (target, url, r2_key, content_hash, archive_url, captured_at)
     VALUES (?1,?2,?3,?4,?5,?6) RETURNING id`
  )
    .bind(s.target, s.url, s.r2Key, s.hash, s.archiveUrl, s.capturedAt)
    .first<{ id: number }>();
  return row?.id ?? 0;
}
