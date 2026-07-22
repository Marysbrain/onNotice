// Deterministic tagging. No model, no guesses. Carrier comes from the question or
// the records, topic from the first matched issue term, sentiment from whether
// the cited evidence hits a negative issue term.

import { matchCarrier, matchIssueTerms } from "../lib/taxonomy.js";
import type { Intent } from "./router.js";
import type { ResultRecord, Tags } from "./types.js";

// Issue-term ids that describe harm to a consumer. A hit in the question or in a
// cited excerpt makes sentiment negative. This list is the whole of the
// sentiment rule: there is no positive path, because the library does not judge a
// terms change as favorable (that would be commentary, not a fact). Sentiment is
// therefore only ever "negative" or "neutral".
const NEGATIVE_ISSUE_IDS = new Set([
  "clawback",
  "credit_clawback",
  "credit_forfeit",
  "credit_forfeit_alt",
  "promotional_credit_removed",
  "credit_stopped",
  "credit_disappeared",
  "service_cancelled_credits",
  "balance_accelerated",
  "remaining_balance_due",
  "unjust_enrichment",
]);

export function tagFor(question: string, _intent: Intent, records: ResultRecord[]): Tags {
  // Carrier: the one named in the question wins; otherwise the dominant carrier
  // across the returned records.
  let carrier = matchCarrier(question);
  if (!carrier && records.length) {
    const counts = new Map<string, number>();
    for (const r of records) {
      if (r.carrier) counts.set(r.carrier, (counts.get(r.carrier) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestN = 0;
    for (const [c, n] of counts) {
      if (n > bestN) {
        best = c;
        bestN = n;
      }
    }
    carrier = best;
  }

  // Topic: first issue-term id present in the question.
  const topicHits = matchIssueTerms(question);
  const topic = topicHits[0] ?? null;

  // Sentiment: negative if the question or any cited excerpt trips a harm term.
  let sentiment: Tags["sentiment"] = "neutral";
  const haystacks = [question, ...records.map((r) => r.excerpt)];
  outer: for (const h of haystacks) {
    for (const id of matchIssueTerms(h)) {
      if (NEGATIVE_ISSUE_IDS.has(id)) {
        sentiment = "negative";
        break outer;
      }
    }
  }

  return { carrier: carrier ?? null, topic, sentiment };
}
