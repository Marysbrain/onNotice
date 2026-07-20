import type { Env } from "./env.js";
import { claimNextJobs, completeJob, failJob, enqueueJob, type Job } from "./db/jobs.js";
import { processParseFile, type ParseFilePayload } from "./processors/parse-file.js";
import { runClassify } from "./classify/run.js";
import { runCorroborate } from "./classify/corroborate.js";
import { runLinks } from "./classify/links.js";
import { runPublish } from "./publish/publish.js";
import { collectArb } from "./collectors/arb.js";
import { runFtcBackfill } from "./backfill/ftc-backfill.js";
import { runCourtListenerBackfill } from "./backfill/courtlistener-backfill.js";
import { runFccAggregateBackfill } from "./backfill/fcc-aggregate-backfill.js";
import { runWaybackBackfill } from "./backfill/wayback-backfill.js";

// Small batch per run so we stay inside the free CPU budget. Cron fires every
// 5 minutes, so throughput is batch * 288/day. Raise slowly, watching CPU.
const BATCH = 5;

// Claim a batch and run each job. On success complete it; on error hand to
// failJob, which reschedules with backoff or dead-letters after max_attempts.
export async function runJobs(env: Env): Promise<{ ran: number; done: number; failed: number }> {
  const jobs = await claimNextJobs(env, BATCH);
  let done = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      await dispatch(env, job);
      await completeJob(env, job.id);
      done++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await failJob(env, job, msg);
      failed++;
    }
  }
  return { ran: jobs.length, done, failed };
}

async function dispatch(env: Env, job: Job): Promise<void> {
  switch (job.type) {
    case "parse_file": {
      const payload = JSON.parse(job.payload) as ParseFilePayload;
      await processParseFile(env, payload);
      // deferred xlsx still counts as done. The CI escape hatch parses the raw.
      return;
    }
    // Track C jobs. Each does a small bounded batch so several can share one
    // invocation without breaching the 50-queries-per-invocation free limit.
    case "classify":
      await runClassify(env);
      return;
    case "corroborate":
      await runCorroborate(env);
      return;
    case "link":
      await runLinks(env);
      return;
    case "publish":
      await runPublish(env);
      return;

    // Backfill jobs. Each does one bounded batch and re-enqueues a continuation
    // while more work remains, so the */5 runner walks the history in small
    // chunks. All ship idle: nothing runs until a backfill is triggered.
    case "arb_backfill":
      // One-shot. Forces a fresh AAA/JAMS download and parse regardless of cursor.
      await collectArb(env, { force: true });
      return;
    case "ftc_backfill": {
      const r = await runFtcBackfill(env);
      if (r.more) await enqueueJob(env, "ftc_backfill", `ftc_backfill:${r.cursorKey}:${Date.now()}`);
      return;
    }
    case "courtlistener_backfill": {
      const r = await runCourtListenerBackfill(env);
      if (r.more) await enqueueJob(env, "courtlistener_backfill", `courtlistener_backfill:${r.cursorKey}:${Date.now()}`);
      return;
    }
    case "fcc_aggregate_backfill": {
      const r = await runFccAggregateBackfill(env);
      if (r.more) await enqueueJob(env, "fcc_aggregate_backfill", `fcc_aggregate_backfill:${r.cursorKey}:${Date.now()}`);
      return;
    }
    case "wayback_backfill": {
      const r = await runWaybackBackfill(env);
      if (r.more) await enqueueJob(env, "wayback_backfill", `wayback_backfill:${r.cursorKey}:${Date.now()}`);
      return;
    }
    default:
      throw new Error(`unknown job type: ${job.type}`);
  }
}
