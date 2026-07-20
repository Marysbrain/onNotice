// Shared fetch helpers. Rate discipline lives here: 429 handling with
// Retry-After, and a plain JSON getter with a required User-Agent.
//
// Both are injectable (fetchImpl, sleepImpl) so the retry path is testable
// without real network or real waiting.

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepImpl = (ms: number) => Promise<void>;

const realSleep: SleepImpl = (ms) => new Promise((r) => setTimeout(r, ms));

// Parse a Retry-After header. Supports integer seconds and HTTP-date. Returns
// milliseconds to wait, or null if the header is missing or unparseable.
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - nowMs);
  return null;
}

export interface RetryOptions {
  retries?: number;
  // Fallback wait when a 429 has no usable Retry-After header.
  defaultDelayMs?: number;
  fetchImpl?: FetchImpl;
  sleepImpl?: SleepImpl;
}

// Fetch with 429 handling. On a 429 we wait for Retry-After (or defaultDelayMs)
// and try again, up to `retries` times. Other statuses return as-is; the caller
// decides what a non-ok status means. This is how we honor the GDELT 1-req-per-5s
// rule and the api.data.gov hourly cap without hammering.
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {}
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const defaultDelayMs = opts.defaultDelayMs ?? 5000;
  const doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const sleep = opts.sleepImpl ?? realSleep;

  let attempt = 0;
  for (;;) {
    const res = await doFetch(url, init);
    if (res.status !== 429 || attempt >= retries) return res;
    const wait = parseRetryAfter(res.headers.get("retry-after")) ?? defaultDelayMs;
    await sleep(wait);
    attempt++;
  }
}
