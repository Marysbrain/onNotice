import type { Env } from "../env.js";
import type { FetchImpl } from "../lib/http.js";
import { enabledSources } from "../db/records.js";
import { sha256Hex } from "../lib/hash.js";
import { normalizeText, unifiedDiff } from "../lib/diff.js";

// Wayback CDX backfill. Gives the terms archive a past. For each terms target we
// query the CDX API for capture history (matchType=prefix, collapse=digest,
// output=json, from=2019), store one terms_snapshots row per distinct capture,
// and diff consecutive captures the same way live snapshots diff.
//
// The deployed terms_snapshots.r2_key is NOT NULL, so backfill rows use a
// sentinel key "wayback:<timestamp>" meaning "no local R2 object, archived at
// archive_url". Small batches per run; CDX has no documented hard cap but we
// throttle anyway.

const CDX = "https://web.archive.org/cdx/search/cdx";
const CAPTURES_PER_RUN = 4;

export interface Capture {
  timestamp: string; // YYYYMMDDhhmmss
  original: string;
  digest: string;
  status: string;
}

export function buildCdxUrl(target: string): string {
  const params = new URLSearchParams({
    url: target,
    matchType: "prefix",
    collapse: "digest",
    output: "json",
    from: "2019",
    fl: "timestamp,original,digest,statuscode",
  });
  return `${CDX}?${params.toString()}`;
}

// CDX json is an array of rows; the first row is the field-name header.
export function parseCdx(json: unknown): Capture[] {
  if (!Array.isArray(json) || json.length < 2) return [];
  const rows = json.slice(1) as unknown[];
  const out: Capture[] = [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const [timestamp, original, digest, status] = r as string[];
    if (!timestamp || !original) continue;
    out.push({ timestamp, original, digest: digest ?? "", status: status ?? "" });
  }
  return out;
}

export function timestampToEpoch(ts: string): number {
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/);
  if (!m) return 0;
  return Math.floor(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) / 1000);
}

export function snapshotUrl(ts: string, original: string): string {
  return `https://web.archive.org/web/${ts}/${original}`;
}
function contentUrl(ts: string, original: string): string {
  return `https://web.archive.org/web/${ts}id_/${original}`;
}

// Pure diff chaining: given captures in time order with normalized text, emit a
// diff for each step where the hash changed. Tested directly.
export interface DiffStep {
  from_hash: string;
  to_hash: string;
  diff: string;
}
export function buildSnapshotDiffs(seq: Array<{ hash: string; text: string }>): DiffStep[] {
  const out: DiffStep[] = [];
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1]!;
    const cur = seq[i]!;
    if (prev.hash === cur.hash) continue;
    out.push({ from_hash: prev.hash, to_hash: cur.hash, diff: unifiedDiff(prev.text, cur.text, prev.hash, cur.hash) });
  }
  return out;
}

export async function runWaybackBackfill(
  env: Env,
  deps: { fetchImpl?: FetchImpl } = {}
): Promise<{ target: string | null; captures: number; diffs: number; more: boolean; cursorKey: string }> {
  const doFetch = deps.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const targets = await enabledSources(env, "terms_page");
  const usable = targets.filter((t) => t.url && !t.url.includes("REPLACE_WITH_REAL_TERMS_URL"));
  if (usable.length === 0) return { target: null, captures: 0, diffs: 0, more: false, cursorKey: "" };

  // One target per run, chosen by a round-robin cursor.
  const tRaw = await env.CONFIG.get("cursor:wayback_target");
  const tIdx = tRaw ? Number(tRaw) % usable.length : 0;
  const target = usable[tIdx]!;

  const idxRaw = await env.CONFIG.get(`cursor:wayback:${target.id}`);
  const startIdx = idxRaw ? Number(idxRaw) : 0;

  let captures: Capture[] = [];
  try {
    const res = await doFetch(buildCdxUrl(target.url!), { headers: { "User-Agent": "carriers-on-notice/0.1 (+contact@athipp.com)", Accept: "application/json" } });
    if (res.ok) captures = parseCdx(await res.json());
  } catch {
    captures = [];
  }

  const batch = captures.slice(startIdx, startIdx + CAPTURES_PER_RUN);
  const seq: Array<{ hash: string; text: string; capture: Capture }> = [];
  for (const cap of batch) {
    let text = "";
    try {
      const res = await doFetch(contentUrl(cap.timestamp, cap.original), { headers: { "User-Agent": "carriers-on-notice/0.1 (+contact@athipp.com)" } });
      if (res.ok) text = normalizeText(await res.text());
    } catch {
      text = "";
    }
    const hash = await sha256Hex(text);
    seq.push({ hash, text, capture: cap });

    await env.DB.prepare(
      `INSERT OR IGNORE INTO terms_snapshots (target, url, r2_key, content_hash, archive_url, captured_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
      .bind(
        target.id,
        cap.original,
        `wayback:${cap.timestamp}`,
        hash,
        snapshotUrl(cap.timestamp, cap.original),
        timestampToEpoch(cap.timestamp)
      )
      .run();
  }

  // Diff consecutive captures within this batch.
  const steps = buildSnapshotDiffs(seq.map((s) => ({ hash: s.hash, text: s.text })));
  for (const step of steps) {
    await env.DB.prepare(
      `INSERT INTO terms_diffs (target, from_snap_id, to_snap_id, from_hash, to_hash, diff)
       VALUES (?1, NULL, 0, ?2, ?3, ?4)`
    )
      .bind(target.id, step.from_hash, step.to_hash, step.diff)
      .run();
  }

  const nextIdx = startIdx + batch.length;
  const more = nextIdx < captures.length;
  await env.CONFIG.put(`cursor:wayback:${target.id}`, String(more ? nextIdx : 0));
  if (!more) await env.CONFIG.put("cursor:wayback_target", String((tIdx + 1) % usable.length));

  return { target: target.id, captures: batch.length, diffs: steps.length, more, cursorKey: String(nextIdx) };
}
