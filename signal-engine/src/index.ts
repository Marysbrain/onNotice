import type { Env } from "./env.js";
import { runJobs } from "./runner.js";
import { collectFtcRss } from "./collectors/ftc-rss.js";
import { collectArb } from "./collectors/arb.js";
import { collectTerms } from "./collectors/terms.js";
import { collectCaAg } from "./collectors/ca-ag.js";
import { collectEdgar } from "./collectors/edgar.js";
import { collectSocrata } from "./collectors/socrata.js";
import { collectEcfs } from "./collectors/ecfs.js";
import { collectNews } from "./collectors/news.js";
import { collectBluesky } from "./collectors/bluesky.js";
import { collectHackerNews } from "./collectors/hackernews.js";
import { purgeBluesky } from "./purge/bluesky-purge.js";
import { purgeHackerNews } from "./purge/hackernews-purge.js";
import { enqueueJob } from "./db/jobs.js";
import { runClassify } from "./classify/run.js";
import { runCorroborate } from "./classify/corroborate.js";
import { runLinks } from "./classify/links.js";
import { runPublish } from "./publish/publish.js";

// Two cron triggers (see wrangler.jsonc). We branch on controller.cron:
//   */5 * * * *  -> drain the job queue
//   0 * * * *    -> hourly dispatcher, kicks collectors by UTC hour
export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === "*/5 * * * *") {
      ctx.waitUntil(runJobs(env).then((r) => log("jobs", r)));
      return;
    }
    // Hourly dispatcher.
    const hour = new Date(controller.scheduledTime).getUTCHours();
    ctx.waitUntil(dispatchHourly(env, hour));
  },

  // Minimal HTTP surface: health, and a guarded manual trigger for testing a
  // single collector without waiting for cron.
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return json({ ok: true, env: env.ENVIRONMENT });
    }

    if (url.pathname === "/run") {
      const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
        return json({ error: "unauthorized" }, 401);
      }
      const task = url.searchParams.get("task");
      switch (task) {
        case "ftc":
          return json({ task, result: await collectFtcRss(env) });
        case "arb":
          return json({ task, result: await collectArb(env) });
        case "terms":
          return json({ task, result: await collectTerms(env) });
        case "caag":
          return json({ task, result: await collectCaAg(env) });
        case "edgar":
          return json({ task, result: await collectEdgar(env) });
        case "socrata":
          return json({ task, result: await collectSocrata(env) });
        case "ecfs":
          return json({ task, result: await collectEcfs(env) });
        case "news":
          return json({ task, result: await collectNews(env) });
        case "bsky":
          return json({ task, result: await collectBluesky(env) });
        case "hn":
          return json({ task, result: await collectHackerNews(env) });
        case "purge":
          return json({
            task,
            result: { bluesky: await purgeBluesky(env), hackernews: await purgeHackerNews(env) },
          });
        case "classify":
          return json({ task, result: await runClassify(env) });
        case "corroborate":
          return json({ task, result: await runCorroborate(env) });
        case "link":
          return json({ task, result: await runLinks(env) });
        case "publish":
          return json({ task, result: await runPublish(env) });
        case "jobs":
          return json({ task, result: await runJobs(env) });
        default:
          return json(
            {
              error: "unknown task",
              valid: [
                "ftc", "arb", "terms", "caag", "edgar", "socrata", "ecfs", "news",
                "bsky", "hn", "purge", "classify", "corroborate", "link", "publish", "jobs",
              ],
            },
            400
          );
      }
    }

    return json({ service: "signal-engine", ok: true });
  },
} satisfies ExportedHandler<Env>;

async function dispatchHourly(env: Env, hour: number): Promise<void> {
  // Still just 2 cron triggers. This dispatcher spreads collectors across the
  // day by UTC hour so no single run does too much, and API sources stay gentle.
  //
  // FTC feeds every 6 hours. Cheap, so frequent is fine.
  if (hour % 6 === 0) await collectFtcRss(env).then((r) => log("ftc", r));
  // California AG news once a day at 02:00 UTC.
  if (hour === 2) await collectCaAg(env).then((r) => log("caag", r));
  // Arbitration files change quarterly. A daily check is plenty; run at 03:00 UTC.
  if (hour === 3) await collectArb(env).then((r) => log("arb", r));
  // Terms pages once a day at 04:00 UTC.
  if (hour === 4) await collectTerms(env).then((r) => log("terms", r));
  // SEC EDGAR once a day at 05:00 UTC. Skips if SEC_USER_AGENT is unset.
  if (hour === 5) await collectEdgar(env).then((r) => log("edgar", r));
  // FCC Socrata once a day at 06:00 UTC. Cursor walks history over many days.
  if (hour === 6) await collectSocrata(env).then((r) => log("socrata", r));
  // FCC ECFS once a day at 07:00 UTC. Skips if ECFS_API_KEY is unset.
  if (hour === 7) await collectEcfs(env).then((r) => log("ecfs", r));
  // News radar once a day at 09:00 UTC. Discovery leads only.
  if (hour === 9) await collectNews(env).then((r) => log("news", r));
  // Social listeners once a day. Bluesky at 10:00, Hacker News at 11:00 UTC.
  if (hour === 10) await collectBluesky(env).then((r) => log("bsky", r));
  if (hour === 11) await collectHackerNews(env).then((r) => log("hn", r));

  // Deletion honoring runs every hour, bounded per sweep. This is what makes the
  // weekly re-check guarantee hold (see the math in each purge module). Both are
  // no-ops when there are no stored records for that source.
  await purgeBluesky(env).then((r) => log("purge_bsky", r));
  await purgeHackerNews(env).then((r) => log("purge_hn", r));

  // Track C. Enqueue the classify/corroborate/link/publish jobs every hour. The
  // */5 job runner claims and processes them in small bounded batches. Dedupe by
  // the hour bucket so re-entry within the same hour is a no-op.
  const bucket = Math.floor(Date.parse(new Date().toISOString().slice(0, 13) + ":00:00Z") / 1000);
  await enqueueJob(env, "classify", `classify:${bucket}`);
  await enqueueJob(env, "corroborate", `corroborate:${bucket}`);
  await enqueueJob(env, "link", `link:${bucket}`);
  await enqueueJob(env, "publish", `publish:${bucket}`);
}

function log(tag: string, data: unknown): void {
  console.log(JSON.stringify({ tag, data }));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
