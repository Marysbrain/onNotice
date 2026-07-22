// Pure routing helpers for the /ask brain. No DB, no IO, so every branch is unit
// testable. The router decides intent and turns a free-text question into a
// bounded FTS5 query. It never composes an answer: templates live in answer.ts.

export type Intent = "count" | "trend" | "topic";

// Intent detection is keyword-first and deterministic. Order matters: a "how
// many" question is a count even if it also says "improved". Count is the
// narrowest signal, so it is checked first, then trend, then topic as default.
export function classifyIntent(question: string): Intent {
  const h = question.toLowerCase();
  if (/\bhow many\b/.test(h) || /\bnumber of\b/.test(h) || /\bhow much\b/.test(h) || /\bcount\b/.test(h)) {
    return "count";
  }
  if (
    /\bimproved?\b/.test(h) ||
    /\bimproving\b/.test(h) ||
    /\bbetter\b/.test(h) ||
    /\bworse\b/.test(h) ||
    /\bworsened\b/.test(h) ||
    /\btrend\b/.test(h) ||
    /\bover time\b/.test(h) ||
    /\bchanged over\b/.test(h) ||
    /\bgotten worse\b/.test(h) ||
    /\bgetting better\b/.test(h)
  ) {
    return "trend";
  }
  return "topic";
}

// Map a record's source_id to one of the three count buckets used in the count
// template. Arbitration files (aaa_arb, jams_arb) and court records
// (courtlistener) are named explicitly by substring; everything else is a
// regulator or press source (ftc_*, ca_ag_*, sec_edgar, fcc_*, news_*).
export function sourceCategory(sourceId: string | null): "arbitration" | "court" | "regulator_press" {
  const s = (sourceId ?? "").toLowerCase();
  if (s.includes("arb")) return "arbitration";
  if (s.includes("court")) return "court";
  return "regulator_press";
}

// A small, plain English stopword list plus the question words that would only
// add noise to an FTS query. Kept deliberately short. Removing generic corpus
// words like "issue" and "carrier" keeps the OR query pointed at real topic
// terms (clawback, credits, trade-in) instead of matching everything.
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "doing", "has", "have", "had", "having",
  "of", "in", "on", "to", "for", "with", "as", "at", "by", "from", "into",
  "and", "or", "but", "if", "then", "than", "so", "that", "this", "these", "those",
  "how", "what", "who", "whom", "why", "when", "where", "which", "whose",
  "i", "me", "my", "mine", "we", "us", "our", "you", "your", "yours",
  "they", "them", "their", "it", "its", "he", "she", "his", "her",
  "about", "can", "could", "would", "should", "will", "shall", "may", "might", "must",
  "get", "got", "getting", "any", "all", "some", "more", "most", "many", "much",
  "tell", "show", "give", "list", "please", "know", "want", "need", "there",
  "record", "records", "library", "verified", "vetted", "issue", "issues",
  "problem", "problems", "carrier", "carriers", "company", "companies",
  "over", "time", "yet", "still", "just", "only", "even", "ever",
]);

// Turn a question into an FTS5 MATCH string: lowercase, keep alphanumeric tokens
// only (so no FTS operator can ever be injected), drop stopwords and 1-char
// tokens, dedupe, join with OR. Returns "" when nothing meaningful is left, which
// the caller reads as "no query, no results".
export function buildFtsQuery(question: string): string {
  const tokens = question.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const t of tokens) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    kept.push(t);
  }
  return kept.join(" OR ");
}
