import type { Env } from "../env.js";

export interface Job {
  id: number;
  type: string;
  dedupe_key: string;
  payload: string;
  status: string;
  attempts: number;
  max_attempts: number;
  scheduled_at: number;
  claimed_at: number | null;
  error: string | null;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

// Enqueue a job. Idempotent by the unique (type, dedupe_key) index, so calling
// this twice for the same work is a no-op. Returns true if a new row landed.
export async function enqueueJob(
  env: Env,
  type: string,
  dedupeKey: string,
  payload: Record<string, unknown> = {}
): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO jobs (type, dedupe_key, payload, scheduled_at)
     VALUES (?1, ?2, ?3, ?4)`
  )
    .bind(type, dedupeKey, JSON.stringify(payload), now())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// Claim up to `limit` runnable jobs. Two-step so the claim is atomic per row:
// pick candidate ids, then flip each with a guarded UPDATE ... RETURNING. Only
// rows we actually flipped (status was still pending) come back to us. This is
// safe even if two invocations overlap.
export async function claimNextJobs(env: Env, limit = 10): Promise<Job[]> {
  const t = now();
  const candidates = await env.DB.prepare(
    `SELECT id FROM jobs
      WHERE status = 'pending' AND scheduled_at <= ?1
      ORDER BY id
      LIMIT ?2`
  )
    .bind(t, limit)
    .all<{ id: number }>();

  const claimed: Job[] = [];
  for (const row of candidates.results ?? []) {
    const got = await env.DB.prepare(
      `UPDATE jobs
          SET status = 'claimed', claimed_at = ?2, attempts = attempts + 1, updated_at = ?2
        WHERE id = ?1 AND status = 'pending'
      RETURNING *`
    )
      .bind(row.id, t)
      .first<Job>();
    if (got) claimed.push(got);
  }
  return claimed;
}

// Mark a claimed job done.
export async function completeJob(env: Env, id: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs SET status = 'done', error = NULL, updated_at = ?2 WHERE id = ?1`
  )
    .bind(id, now())
    .run();
}

// Backoff: 60s, doubling, capped at 1 hour.
function backoffSeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600);
}

// Fail a job. Reschedule with backoff if attempts remain, else dead-letter.
// Returns the resulting status so callers can log it.
export async function failJob(env: Env, job: Job, error: string): Promise<"pending" | "dead"> {
  const t = now();
  const msg = error.slice(0, 1000);
  if (job.attempts >= job.max_attempts) {
    await env.DB.prepare(
      `UPDATE jobs SET status = 'dead', error = ?2, updated_at = ?3 WHERE id = ?1`
    )
      .bind(job.id, msg, t)
      .run();
    return "dead";
  }
  const nextAt = t + backoffSeconds(job.attempts);
  await env.DB.prepare(
    `UPDATE jobs SET status = 'pending', scheduled_at = ?2, error = ?3, updated_at = ?4 WHERE id = ?1`
  )
    .bind(job.id, nextAt, msg, t)
    .run();
  return "pending";
}
