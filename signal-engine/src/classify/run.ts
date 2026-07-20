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
// Batch is small on purpose: 8 records * (1 update each) plus 1 select stays well
// under the 50-queries-per-invocation free limit, even when the runner claims
// this job alongside others.
const BATCH = 8;

interface Row {
  id: number;
  excerpt: string;
  carrier: string | null;
}

export async function runClassify(
  env: Env,
  classifier?: Classifier
): Promise<{ processed: number; cleared: number; queued: number }> {
  const clf = classifier ?? (await selectClassifier(env));
  const bar = await confidenceBar(env);

  const candidates = await env.DB.prepare(
    `SELECT id, excerpt, carrier FROM records WHERE review_status = 'unrouted' ORDER BY id LIMIT ?1`
  )
    .bind(BATCH)
    .all<Row>();

  let cleared = 0;
  let queued = 0;
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
      const ai = await clf.classify({ excerpt: row.excerpt, carrier: row.carrier });
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

    if (clears) cleared++;
    else queued++;
  }

  return { processed: (candidates.results ?? []).length, cleared, queued };
}
