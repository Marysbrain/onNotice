// HTTP surface for the brain. GET /ask?q=... for easy testing, POST /ask with a
// JSON body {"question": string}. Rate limited per caller. Follows the json()
// style of the main worker.

import type { Env } from "../env.js";
import { answerQuestion } from "./answer.js";
import { checkRateLimit } from "./ratelimit.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readQuestion(req: Request, url: URL): Promise<string | null> {
  if (req.method === "POST") {
    try {
      const body = (await req.json()) as { question?: unknown };
      return typeof body.question === "string" ? body.question : null;
    } catch {
      return null;
    }
  }
  return url.searchParams.get("q");
}

export async function handleAsk(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  // Rate limit on a hash of the caller IP. The raw IP is never stored.
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const allowed = await checkRateLimit(env, ip);
  if (!allowed) return json({ error: "rate limited" }, 429);

  const question = await readQuestion(req, url);
  if (!question || !question.trim()) {
    return json({ error: "question required" }, 400);
  }

  const answer = await answerQuestion(env, question.trim());
  return json(answer);
}
