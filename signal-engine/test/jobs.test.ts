import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { enqueueJob, claimNextJobs, completeJob, failJob } from "../src/db/jobs.js";
import { insertRecord } from "../src/db/records.js";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM jobs");
  await env.DB.exec("DELETE FROM records");
});

describe("job enqueue + dedupe", () => {
  it("enqueues once, ignores the duplicate", async () => {
    const first = await enqueueJob(env, "parse_file", "key-1", { a: 1 });
    const second = await enqueueJob(env, "parse_file", "key-1", { a: 1 });
    expect(first).toBe(true);
    expect(second).toBe(false);
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").all<{ n: number }>();
    expect(results![0]!.n).toBe(1);
  });
});

describe("claim logic", () => {
  it("claims pending jobs and flips status + attempts", async () => {
    await enqueueJob(env, "parse_file", "k1");
    await enqueueJob(env, "parse_file", "k2");
    const claimed = await claimNextJobs(env, 10);
    expect(claimed.length).toBe(2);
    expect(claimed[0]!.status).toBe("claimed");
    expect(claimed[0]!.attempts).toBe(1);
    // A second claim returns nothing; none are pending now.
    const again = await claimNextJobs(env, 10);
    expect(again.length).toBe(0);
  });

  it("respects the batch limit", async () => {
    for (let i = 0; i < 5; i++) await enqueueJob(env, "parse_file", `b${i}`);
    const claimed = await claimNextJobs(env, 2);
    expect(claimed.length).toBe(2);
  });

  it("does not claim jobs scheduled in the future", async () => {
    await enqueueJob(env, "parse_file", "future");
    const future = Math.floor(Date.now() / 1000) + 3600;
    await env.DB.prepare("UPDATE jobs SET scheduled_at = ?1 WHERE dedupe_key = 'future'").bind(future).run();
    const claimed = await claimNextJobs(env, 10);
    expect(claimed.length).toBe(0);
  });
});

describe("retry + dead-letter", () => {
  it("reschedules a failed job with backoff while attempts remain", async () => {
    await enqueueJob(env, "parse_file", "retry");
    const [job] = await claimNextJobs(env, 1);
    const status = await failJob(env, job!, "boom");
    expect(status).toBe("pending");
    const row = await env.DB.prepare("SELECT status, scheduled_at, error FROM jobs WHERE id = ?1")
      .bind(job!.id)
      .first<{ status: string; scheduled_at: number; error: string }>();
    expect(row!.status).toBe("pending");
    expect(row!.error).toBe("boom");
    expect(row!.scheduled_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("dead-letters once attempts hit max", async () => {
    await enqueueJob(env, "parse_file", "dead");
    const [job] = await claimNextJobs(env, 1);
    // Force attempts to the ceiling.
    await env.DB.prepare("UPDATE jobs SET attempts = max_attempts WHERE id = ?1").bind(job!.id).run();
    const reloaded = { ...job!, attempts: job!.max_attempts };
    const status = await failJob(env, reloaded, "final");
    expect(status).toBe("dead");
    const row = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?1").bind(job!.id).first<{ status: string }>();
    expect(row!.status).toBe("dead");
  });

  it("completeJob marks done", async () => {
    await enqueueJob(env, "parse_file", "ok");
    const [job] = await claimNextJobs(env, 1);
    await completeJob(env, job!.id);
    const row = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?1").bind(job!.id).first<{ status: string }>();
    expect(row!.status).toBe("done");
  });
});

describe("record dedupe", () => {
  it("insertRecord is idempotent on dedupe_key", async () => {
    const base = {
      dedupeKey: "ftc:https://example.gov/x",
      sourceId: "ftc_rss_press",
      sourceUrl: "https://example.gov/x",
      captureDate: 1000,
      excerpt: "title - desc",
      vettingStatus: "verified_primary" as const,
    };
    const a = await insertRecord(env, base);
    const b = await insertRecord(env, base);
    expect(a).toBe(true);
    expect(b).toBe(false);
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM records").all<{ n: number }>();
    expect(results![0]!.n).toBe(1);
  });
});
