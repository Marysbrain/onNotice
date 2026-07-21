import type { Env } from "../env.js";
import { enabledSources, touchSource, type SourceRow } from "../db/records.js";
import { enqueueJob } from "../db/jobs.js";
import { saveToWayback } from "../lib/wayback.js";

const UA = "carriers-on-notice/0.1 (+contact@carriersonnotice.com)";

// Resolve the current data-file link on an arbitration landing page. Best-effort:
// scan anchors for xlsx/xls/csv. Prefer a link whose text/href names a year, so
// we grab the latest quarterly file. The exact selector must be confirmed on the
// first real download (SOURCE-REGISTRY open item 1).
export function resolveFileLink(html: string, baseUrl: string): string | null {
  const hrefs = [...html.matchAll(/href="([^"]+\.(?:xlsx|xls|csv))"/gi)].map((m) => m[1]!);
  if (hrefs.length === 0) return null;
  const yearRe = /20\d\d/;
  const withYear = hrefs.filter((h) => yearRe.test(h));
  const pick = (withYear.length ? withYear : hrefs).sort().reverse()[0]!;
  try {
    return new URL(pick, baseUrl).toString();
  } catch {
    return null;
  }
}

// Check one arbitration source: resolve the file link, and if it is new since
// last run, stream it to R2 and enqueue a parse job. Downloading is I/O, not CPU,
// so it fits the free budget. Parsing the xlsx does not; that is the escape hatch
// (see scripts/parse-xlsx.mjs and the README).
async function checkOne(env: Env, src: SourceRow, force = false): Promise<{ source: string; downloaded: boolean }> {
  if (!src.url) return { source: src.id, downloaded: false };

  const pageRes = await fetch(src.url, { headers: { "User-Agent": UA } });
  if (!pageRes.ok) return { source: src.id, downloaded: false };
  const html = await pageRes.text();

  const fileUrl = resolveFileLink(html, src.url);
  if (!fileUrl) {
    await touchSource(env, src.id);
    return { source: src.id, downloaded: false };
  }

  // Skip if we already handled this exact file, unless this is a forced backfill.
  // The quarterly files carry about five years of history by law, so one full
  // parse IS the backfill.
  const cursor = parseCursor(src.cursor);
  if (!force && cursor.lastFileUrl === fileUrl) {
    await touchSource(env, src.id);
    return { source: src.id, downloaded: false };
  }

  const fileRes = await fetch(fileUrl, { headers: { "User-Agent": UA } });
  if (!fileRes.ok || !fileRes.body) {
    await touchSource(env, src.id);
    return { source: src.id, downloaded: false };
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = fileUrl.split("/").pop() || "file.xlsx";
  const r2Key = `arb/${src.id}/${stamp}/${filename}`;
  await env.RAW.put(r2Key, fileRes.body, {
    httpMetadata: { contentType: fileRes.headers.get("content-type") ?? "application/octet-stream" },
    customMetadata: { sourceUrl: fileUrl, sourceId: src.id, capturedAt: String(Math.floor(Date.now() / 1000)) },
  });

  const wb = await saveToWayback(env, fileUrl);

  // Enqueue the parse job. Dedupe by r2Key so re-runs are no-ops.
  await enqueueJob(env, "parse_file", r2Key, {
    r2Key,
    sourceId: src.id,
    provider: src.id === "aaa_arb" ? "aaa" : "jams",
    sourceUrl: fileUrl,
    archiveUrl: wb.archiveUrl ?? null,
  });

  await touchSource(env, src.id, JSON.stringify({ ...cursor, lastFileUrl: fileUrl }));
  return { source: src.id, downloaded: true };
}

export async function collectArb(
  env: Env,
  opts: { force?: boolean } = {}
): Promise<{ source: string; downloaded: boolean }[]> {
  const sources = await enabledSources(env, "arb_file");
  const out: { source: string; downloaded: boolean }[] = [];
  for (const src of sources) {
    try {
      out.push(await checkOne(env, src, opts.force ?? false));
    } catch {
      out.push({ source: src.id, downloaded: false });
    }
  }
  return out;
}

interface ArbCursor {
  lastFileUrl?: string;
}
function parseCursor(raw: string | null): ArbCursor {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ArbCursor;
  } catch {
    return {};
  }
}
