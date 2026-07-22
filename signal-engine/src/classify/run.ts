import type { Env } from "../env.js";
import { confidenceBar } from "../lib/config.js";
import { deterministicClassify } from "./tagger.js";
import { selectClassifier, type Classifier } from "./classifier.js";

// Classify unrouted records. Deterministic pass first; the AI stage handles what
// it cannot resolve. Confidence routing decides review_status:
//   confidence >= bar  -> review_status = cleared  (may feed aggregates)
//   confidence <  bar  -> review_status = queued   (held for human review)
//
// GUARDRAIL: this never touches vetting_status. Machine confidence is not
// vetting. vetting_status stays single_source until corroboration or a human
// upgrades it.
//
// Two separate limits, because two separate constraints bind us.
//
// CAP is the D1 limit. The deterministic tagger resolves most records with no
// model call, so deterministic work is cheap and should flow through in bulk.
// D1 query math for the worst case of one run:
//   1 SELECT (the batch) + up to CAP UPDATEs (one per processed record) = 1 + CAP.
// Records we skip for AI budget get no UPDATE, so CAP bounds the update count.
// CAP = 25 gives a worst case of 26 queries, about half the 50-queries-per-
// invocation free limit. That leaves headroom for the other jobs the runner
// co-claims in the same invocation plus its own claim/complete bookkeeping.
const CAP = 25;

// AI_CALLS_PER_RUN is the model-budget limit, the real bottleneck for the 9,300
// unrouted arbitration records. Once a run spends this many AI calls, any further
// record that would need the model is left unrouted for a later run. We do not
// write it with confidence 0; we simply do not process it this time.
const AI_CALLS_PER_RUN = 8;

interface Row {
  id: number;
  excerpt: string;
  carrier: string | null;
}

export async function runClassify(
  env: Env,
  classifier?: Classifier
): Promise<{ processed: number; cleared: number; queued: number; aiCalls: number }> {
  const clf = classifier ?? (await selectClassifier(env));
  const bar = await confidenceBar(env);

  const candidates = await env.DB.prepare(
    `SELECT id, excerpt, carrier FROM records WHERE review_status = 'unrouted' ORDER BY id LIMIT ?1`
  )
    .bind(CAP)
    .all<Row>();

  let processed = 0;
  let cleared = 0;
  let queued = 0;
  let aiCalls = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const row of candidates.results ?? []) {
    const det = deterministicClassify(row.excerpt);

    let carrier: string | null;
    let promoName: string | null;
    let allegedIssue: string | null;
    let confidence: number;
    let rationale = "deterministic";

    if (det.resolved) {
      carrier = det.carrier;
      promoName = det.promoName;
      allegedIssue = det.allegedIssue;
      confidence = det.confidence ?? 0.95;
    } else {
      // Needs the model. If the AI budget is spent, leave this record unrouted
      // and move on. A later run picks it up. Skipping is not a downgrade: no
      // UPDATE runs, so the record keeps review_status = 'unrouted' untouched.
      // Deterministic records after it in the batch still flow through.
      if (aiCalls >= AI_CALLS_PER_RUN) continue;
      const ai = await clf.classify({ excerpt: row.excerpt, carrier: row.carrier });
      aiCalls++;
      carrier = ai.carrier ?? row.carrier ?? null;
      promoName = ai.promo_name;
      allegedIssue = ai.alleged_issue ?? det.allegedIssue;
      confidence = ai.confidence;
      rationale = ai.rationale || clf.name;
    }

    const clears = confidence >= bar;
    const reviewStatus = clears ? "cleared" : "queued";
    const reviewReason = clears ? null : `confidence ${confidence.toFixed(2)} below bar ${bar.toFixed(2)}: ${rationale}`.slice(0, 300);

    await env.DB.prepare(
      `UPDATE records
          SET carrier = COALESCE(?2, carrier),
              promo_name = ?3,
              alleged_issue = ?4,
              confidence = ?5,
              review_status = ?6,
              review_reason = ?7,
              updated_at = ?8
        WHERE id = ?1`
    )
      .bind(row.id, carrier, promoName, allegedIssue, confidence, reviewStatus, reviewReason, now)
      .run();

    processed++;
    if (clears) cleared++;
    else queued++;
  }

  return { processed, cleared, queued, aiCalls };
}
