import type { Env } from "./env.js";
import { claimNextJobs, completeJob, failJob, type Job } from "./db/jobs.js";
import { processParseFile, type ParseFilePayload } from "./processors/parse-file.js";
import { runClassify } from "./classify/run.js";
import { runCorroborate } from "./classify/corroborate.js";
import { runLinks } from "./classify/links.js";
import { runPublish } from "./publish/publish.js";

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
    default:
      throw new Error(`unknown job type: ${job.type}`);
  }
}
