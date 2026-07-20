import type { Env } from "../env.js";

// KV-backed config with code defaults. Values live in KV as strings under
// config:<key>. A missing key falls back to the code default, so the Worker runs
// with sane values before anyone sets anything. Cursors for incremental jobs
// live under cursor:<key>.

export async function getConfigNumber(env: Env, key: string, fallback: number): Promise<number> {
  const v = await env.CONFIG.get(`config:${key}`);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function getConfigString(env: Env, key: string, fallback: string): Promise<string> {
  const v = await env.CONFIG.get(`config:${key}`);
  return v ?? fallback;
}

export async function getCursor(env: Env, key: string, fallback = 0): Promise<number> {
  const v = await env.CONFIG.get(`cursor:${key}`);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function setCursor(env: Env, key: string, value: number): Promise<void> {
  await env.CONFIG.put(`cursor:${key}`, String(value));
}

// The confidence bar. At or above it a record clears; below it the record is
// queued for human review. Default 0.7.
export function confidenceBar(env: Env): Promise<number> {
  return getConfigNumber(env, "CONFIDENCE_BAR", 0.7);
}

// Per-day API budget counter in KV, keyed budget:<name>:<YYYY-MM-DD>. Used by the
// CourtListener backfill to honor the 125/day free cap: spend one before each
// call, stop when the day is exhausted, resume tomorrow. Keys expire after two
// days so the namespace stays small.
export async function spendBudget(
  env: Env,
  name: string,
  dailyLimit: number,
  day = new Date().toISOString().slice(0, 10)
): Promise<{ allowed: boolean; used: number; remaining: number }> {
  const key = `budget:${name}:${day}`;
  const used = Number((await env.CONFIG.get(key)) ?? "0");
  if (used >= dailyLimit) return { allowed: false, used, remaining: 0 };
  await env.CONFIG.put(key, String(used + 1), { expirationTtl: 172800 });
  return { allowed: true, used: used + 1, remaining: dailyLimit - used - 1 };
}
