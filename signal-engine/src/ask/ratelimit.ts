// Fixed-window rate limit on KV. 20 requests per 5 minutes per caller. The caller
// is keyed by a SHA-256 hash of the IP, never the raw IP, so KV holds no PII.

import type { Env } from "../env.js";
import { sha256Hex } from "../lib/hash.js";

const WINDOW_SECONDS = 5 * 60;
const MAX_PER_WINDOW = 20;

// Returns true if the request is allowed, false if it is over the limit. The
// window index is floor(now / 300), so all requests in the same 5-minute bucket
// share a key that expires on its own via KV TTL.
export async function checkRateLimit(env: Env, ip: string): Promise<boolean> {
  const hashed = await sha256Hex(ip);
  const windowIndex = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const key = `rl:ask:${hashed}:${windowIndex}`;

  const current = Number((await env.CONFIG.get(key)) ?? "0");
  if (current >= MAX_PER_WINDOW) return false;

  // Best-effort increment. A race under concurrency may let a request or two
  // slip; that is acceptable for a free-tier abuse guard. TTL cleans the key up.
  await env.CONFIG.put(key, String(current + 1), { expirationTtl: WINDOW_SECONDS });
  return true;
}
