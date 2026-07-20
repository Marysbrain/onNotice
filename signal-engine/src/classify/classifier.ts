import type { Env } from "../env.js";
import { getConfigString } from "../lib/config.js";
import { carrierList } from "../lib/taxonomy.js";

// The classifier boundary. The deterministic tagger handles the easy cases; this
// interface handles the rest. Two real implementations plus a stub for tests.

export interface ClassifyInput {
  excerpt: string;
  carrier?: string | null;
}

export interface ClassifyResult {
  carrier: string | null;
  promo_name: string | null;
  alleged_issue: string | null;
  confidence: number; // 0..1
  rationale: string;
}

export interface Classifier {
  readonly name: string;
  classify(input: ClassifyInput): Promise<ClassifyResult>;
}

const VALID_CARRIERS = () => carrierList().map((c) => c.id);
const CF_MODEL_DEFAULT = "@cf/meta/llama-3.2-1b-instruct";

// Build a compact instruction. We ask for strict JSON so parsing stays cheap.
function buildPrompt(input: ClassifyInput): string {
  const carriers = VALID_CARRIERS().join(", ");
  return [
    "You label short consumer-complaint snippets about US wireless carriers.",
    `Allowed carrier ids: ${carriers}, or null if none is clearly named.`,
    "Return ONLY a JSON object with keys: carrier (one id or null), promo_name (string or null),",
    "alleged_issue (short phrase or null), confidence (0 to 1), rationale (one short sentence).",
    "Do not guess a carrier that is not named. If unsure, use null and a low confidence.",
    "",
    `Snippet: ${JSON.stringify(input.excerpt.slice(0, 600))}`,
  ].join("\n");
}

// Pull the first JSON object out of a model response and coerce it to a result.
// Any parse trouble yields a null, low-confidence result so the record routes to
// human review rather than getting a wrong label.
export function coerceResult(raw: string): ClassifyResult {
  const fallback: ClassifyResult = {
    carrier: null,
    promo_name: null,
    alleged_issue: null,
    confidence: 0,
    rationale: "unparseable model output",
  };
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return fallback;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return fallback;
  }
  const carrier = typeof obj.carrier === "string" && VALID_CARRIERS().includes(obj.carrier) ? obj.carrier : null;
  const conf = typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0;
  return {
    carrier,
    promo_name: typeof obj.promo_name === "string" ? obj.promo_name : null,
    alleged_issue: typeof obj.alleged_issue === "string" ? obj.alleged_issue : null,
    confidence: conf,
    rationale: typeof obj.rationale === "string" ? obj.rationale.slice(0, 200) : "",
  };
}

// (a) Default. Workers AI, free-tier model. On any failure returns a null,
// zero-confidence result so the record is queued, never mislabeled.
export class WorkersAiClassifier implements Classifier {
  readonly name = "workers_ai";
  constructor(private env: Env, private model = CF_MODEL_DEFAULT) {}

  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    try {
      const res = (await this.env.AI.run(this.model as never, {
        messages: [{ role: "user", content: buildPrompt(input) }],
      } as never)) as { response?: string };
      return coerceResult(typeof res.response === "string" ? res.response : "");
    } catch {
      return { carrier: null, promo_name: null, alleged_issue: null, confidence: 0, rationale: "workers ai error" };
    }
  }
}

// (b) Optional. Anthropic Haiku through Cloudflare AI Gateway.
// COST FLAG: Haiku bills per token. Only used when configured.
export class HaikuClassifier implements Classifier {
  readonly name = "haiku";
  constructor(private env: Env, private accountId: string, private gatewayId: string) {}

  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    if (!this.env.ANTHROPIC_API_KEY) {
      return { carrier: null, promo_name: null, alleged_issue: null, confidence: 0, rationale: "no anthropic key" };
    }
    const url = `https://gateway.ai.cloudflare.com/v1/${this.accountId}/${this.gatewayId}/anthropic/v1/messages`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 300,
          messages: [{ role: "user", content: buildPrompt(input) }],
        }),
      });
      if (!res.ok) {
        return { carrier: null, promo_name: null, alleged_issue: null, confidence: 0, rationale: `haiku http ${res.status}` };
      }
      const data = (await res.json()) as { content?: Array<{ text?: string }> };
      const text = data.content?.map((c) => c.text ?? "").join("") ?? "";
      return coerceResult(text);
    } catch {
      return { carrier: null, promo_name: null, alleged_issue: null, confidence: 0, rationale: "haiku error" };
    }
  }
}

// Deterministic stub for tests. No network, no keys.
export class StubClassifier implements Classifier {
  readonly name = "stub";
  constructor(private fn: (input: ClassifyInput) => ClassifyResult) {}
  classify(input: ClassifyInput): Promise<ClassifyResult> {
    return Promise.resolve(this.fn(input));
  }
}

// Pick the classifier. Default is Workers AI. Switch to Haiku only when config
// CLASSIFIER=haiku and the account/gateway ids are set.
export async function selectClassifier(env: Env): Promise<Classifier> {
  const choice = await getConfigString(env, "CLASSIFIER", "workers_ai");
  if (choice === "haiku") {
    const accountId = await getConfigString(env, "CF_ACCOUNT_ID", "");
    const gatewayId = await getConfigString(env, "AI_GATEWAY_ID", "");
    if (accountId && gatewayId) return new HaikuClassifier(env, accountId, gatewayId);
  }
  return new WorkersAiClassifier(env);
}
