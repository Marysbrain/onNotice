// The deterministic brain. Given a question, it picks an intent, runs the
// eligible-only retrieval, and fills a template. No external model is ever
// called: composition is templates over SQL results, so the answer text cannot
// hallucinate. Zero hallucination by construction.

import type { Env } from "../env.js";
import { carrierList, matchCarrier } from "../lib/taxonomy.js";
import { checkWall } from "./walls.js";
import { classifyIntent, buildFtsQuery, sourceCategory } from "./router.js";
import { tagFor } from "./tags.js";
import { claimTotalForCarrier } from "../publish/claims.js";
import { dollarsFloorGrouped } from "./money.js";
import {
  type AskResponse,
  type Citation,
  type ResultRecord,
  DISCLOSURE,
  METHODOLOGY_CITATION,
} from "./types.js";

// RULE 4, the single most important rule of this feature. Only rows that a human
// cleared AND that reached corroborated-or-better vetting may feed any answer.
// Every retrieval query in this file ends with this clause. Do not loosen it.
const ELIGIBLE = `review_status = 'cleared' AND vetting_status IN ('corroborated','verified_primary')`;

// Answers are capped near 900 characters. The cap is structural, applied to every
// composed answer before it ships.
const ANSWER_CAP = 900;

// carrier id -> terms-page target prefix. The seeded targets are per-page slugs
// like terms_att_tradein_deals and terms_tmo_offer_details, several per carrier,
// so trend answers match on prefix instead of guessing one exact slug.
const TERMS_PREFIX: Record<string, string> = {
  att: "terms_att%",
  verizon: "terms_vz%",
  tmobile: "terms_tmo%",
};

interface IntentResult {
  answer: string;
  citations: Citation[];
  records: ResultRecord[];
  isNoResults: boolean;
}

// --- small deterministic helpers -------------------------------------------

function cap(s: string): string {
  const t = s.trim();
  return t.length <= ANSWER_CAP ? t : t.slice(0, ANSWER_CAP - 1).trimEnd() + "…";
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function carrierDisplay(id: string): string {
  return carrierList().find((c) => c.id === id)?.display ?? id;
}

function fmtDate(sec: number | null): string {
  if (sec == null) return "date unknown";
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function fmtMonth(sec: number | null): string {
  if (sec == null) return "unknown";
  return new Date(sec * 1000).toISOString().slice(0, 7);
}

function toCitation(row: { source_url: string; source_id: string | null; record_date: number | null }): Citation {
  return {
    source_url: row.source_url,
    source_id: row.source_id ?? "unknown",
    record_date: row.record_date ?? null,
  };
}

// Up to three representative eligible records for a carrier, newest first. Used to
// give count and trend answers real citations alongside the methodology link.
async function representatives(env: Env, carrier: string): Promise<Citation[]> {
  const res = await env.DB.prepare(
    `SELECT source_url, source_id, record_date
       FROM records
      WHERE ${ELIGIBLE} AND carrier = ?1
      ORDER BY record_date IS NULL, record_date DESC
      LIMIT 3`
  )
    .bind(carrier)
    .all<{ source_url: string; source_id: string | null; record_date: number | null }>();
  return (res.results ?? []).map(toCitation);
}

// --- intents ----------------------------------------------------------------

// COUNT: aggregate eligible records for a carrier, split into arbitration, court,
// and regulator-or-press buckets by source_id.
async function countIntent(env: Env, question: string): Promise<IntentResult> {
  const carrier = matchCarrier(question);
  if (!carrier) return corpusCount(env);

  const rows = await env.DB.prepare(
    `SELECT source_id, COUNT(*) AS n
       FROM records
      WHERE ${ELIGIBLE} AND carrier = ?1
      GROUP BY source_id`
  )
    .bind(carrier)
    .all<{ source_id: string | null; n: number }>();

  let arb = 0;
  let court = 0;
  let reg = 0;
  for (const r of rows.results ?? []) {
    const cat = sourceCategory(r.source_id);
    if (cat === "arbitration") arb += r.n;
    else if (cat === "court") court += r.n;
    else reg += r.n;
  }
  const total = arb + court + reg;
  const disp = carrierDisplay(carrier);
  let answer =
    `The vetted library holds ${total} ${plural(total, "record", "records")} naming ${disp}: ` +
    `${arb} consumer arbitration ${plural(arb, "case", "cases")}, ` +
    `${court} court ${plural(court, "record", "records")}, ` +
    `${reg} regulator or press ${plural(reg, "record", "records")}. ` +
    `Only corroborated or verified primary records are counted.`;

  // Arbitration dollar sentence, OFF by default. Raw claim-column sums are
  // dominated by absurd outlier asks (single filings claiming billions), so the
  // faithful sum reads as inflation. It stays gated behind CONFIG ASK_CLAIMS=on
  // until the robust-statistics pass (median, capped sums, outlier counts)
  // ships and is reviewed. Real numbers only means real in impression, not
  // just real in arithmetic.
  const claimsFlag = await env.CONFIG.get("ASK_CLAIMS");
  if (claimsFlag === "on") {
    const claim = await claimTotalForCarrier(env, carrier);
    if (claim) {
      answer +=
        ` Consumers brought at least $${dollarsFloorGrouped(claim.cents)} in claims against ` +
        `${disp} in these cases, per the AAA public file.`;
    }
  }

  const citations = await representatives(env, carrier);
  citations.push(METHODOLOGY_CITATION);
  return { answer: cap(answer), citations, records: [{ carrier, excerpt: "" }], isNoResults: false };
}

// COUNT with no carrier named: report the whole eligible corpus split by carrier.
async function corpusCount(env: Env): Promise<IntentResult> {
  const { total, parts } = await corpusBreakdown(env);
  const answer =
    `The vetted library holds ${total} verified ${plural(total, "record", "records")} total: ${parts}. ` +
    `Name a carrier for a per-company count. Only corroborated or verified primary records are counted.`;
  return { answer: cap(answer), citations: [METHODOLOGY_CITATION], records: [], isNoResults: false };
}

// TREND: refuse the value judgment, then give the numbers. Yearly eligible record
// counts plus the count and date range of captured terms-page changes.
async function trendIntent(env: Env, question: string): Promise<IntentResult> {
  const carrier = matchCarrier(question);
  if (!carrier) {
    const answer =
      "Better or worse is a judgment the library does not make, and no carrier was named, so I cannot compute a trend. " +
      "Name a carrier and I will show the yearly record counts.";
    return { answer: cap(answer), citations: [METHODOLOGY_CITATION], records: [], isNoResults: false };
  }
  const disp = carrierDisplay(carrier);

  const years = await env.DB.prepare(
    `SELECT strftime('%Y', record_date, 'unixepoch') AS yr, COUNT(*) AS n
       FROM records
      WHERE ${ELIGIBLE} AND carrier = ?1 AND record_date IS NOT NULL
      GROUP BY yr
      ORDER BY yr`
  )
    .bind(carrier)
    .all<{ yr: string; n: number }>();

  const prefix = TERMS_PREFIX[carrier];
  const diffs = await env.DB.prepare(
    `SELECT COUNT(*) AS n, MIN(created_at) AS lo, MAX(created_at) AS hi
       FROM terms_diffs
      WHERE target LIKE ?1`
  )
    .bind(prefix ?? "terms_none%")
    .first<{ n: number; lo: number | null; hi: number | null }>();

  const yearRows = years.results ?? [];
  const diffCount = diffs?.n ?? 0;

  let answer = `Whether ${disp} got better or worse is a judgment the library does not make. Here are the numbers.`;
  if (yearRows.length) {
    const spread = yearRows.map((y) => `${y.yr}: ${y.n}`).join(", ");
    answer += ` Eligible records by year: ${spread}.`;
  } else {
    answer += ` The library has no dated eligible records for ${disp} yet.`;
  }
  if (diffCount > 0) {
    answer += ` It captured ${diffCount} terms-page ${plural(diffCount, "change", "changes")} for ${disp} between ${fmtMonth(diffs!.lo)} and ${fmtMonth(diffs!.hi)}.`;
  } else {
    answer += ` No terms-page changes were captured for ${disp}.`;
  }
  if (!yearRows.length && diffCount === 0) {
    answer += ` The library cannot support a trend for ${disp} yet.`;
  }

  const citations = await representatives(env, carrier);
  citations.push(METHODOLOGY_CITATION);
  return { answer: cap(answer), citations, records: [{ carrier, excerpt: "" }], isNoResults: false };
}

// TOPIC: full-text search over eligible records, ranked by bm25. Returns null when
// the query is empty or nothing matches, which the caller reads as no results.
async function topicIntent(env: Env, question: string): Promise<IntentResult | null> {
  const q = buildFtsQuery(question);
  if (!q) return null;

  const res = await env.DB.prepare(
    `SELECT r.source_id AS source_id, r.source_url AS source_url, r.record_date AS record_date,
            r.carrier AS carrier, substr(r.excerpt, 1, 200) AS ex,
            COALESCE(s.display, r.source_id, 'source') AS sname
       FROM records_fts f
       JOIN records r ON r.id = f.rowid
       LEFT JOIN sources s ON s.id = r.source_id
      WHERE records_fts MATCH ?1
        AND r.review_status = 'cleared'
        AND r.vetting_status IN ('corroborated','verified_primary')
      ORDER BY bm25(records_fts)
      LIMIT 5`
  )
    .bind(q)
    .all<{
      source_id: string | null;
      source_url: string;
      record_date: number | null;
      carrier: string | null;
      ex: string;
      sname: string;
    }>();

  const rows = res.results ?? [];
  if (!rows.length) return null;

  const items = rows.map((r, i) => `${i + 1}. ${r.ex.trim()} (${r.sname}, ${fmtDate(r.record_date)})`);
  const answer = cap("Here is what the vetted records show. " + items.join(" "));
  const citations = rows.map(toCitation);
  const records: ResultRecord[] = rows.map((r) => ({ carrier: r.carrier, excerpt: r.ex }));
  return { answer, citations, records, isNoResults: false };
}

// NO RESULTS: honest sentence plus the one-line corpus summary. Always carries the
// methodology citation so the cite-or-refuse invariant holds.
async function noResults(env: Env): Promise<IntentResult> {
  const { total, parts } = await corpusBreakdown(env);
  const answer =
    `Our library doesn't have verified records on that yet. Here's what we do have. ` +
    `The library holds ${total} verified ${plural(total, "record", "records")}: ${parts}.`;
  return { answer: cap(answer), citations: [METHODOLOGY_CITATION], records: [], isNoResults: true };
}

async function corpusBreakdown(env: Env): Promise<{ total: number; parts: string }> {
  const res = await env.DB.prepare(
    `SELECT carrier, COUNT(*) AS n FROM records WHERE ${ELIGIBLE} GROUP BY carrier`
  ).all<{ carrier: string | null; n: number }>();

  let total = 0;
  let unattributed = 0;
  const byCarrier = new Map<string, number>();
  for (const r of res.results ?? []) {
    total += r.n;
    if (r.carrier) byCarrier.set(r.carrier, r.n);
    else unattributed += r.n;
  }
  const parts = carrierList().map((c) => `${c.display} ${byCarrier.get(c.id) ?? 0}`);
  if (unattributed) parts.push(`unattributed ${unattributed}`);
  return { total, parts: parts.join(", ") };
}

// --- orchestrator -----------------------------------------------------------

function refusedResponse(sentence: string): AskResponse {
  return {
    answer: sentence,
    citations: [],
    tags: { carrier: null, topic: null, sentiment: "neutral" },
    refused: true,
    disclosure: DISCLOSURE,
  };
}

export async function answerQuestion(env: Env, question: string): Promise<AskResponse> {
  const wall = checkWall(question);
  if (wall?.hard) {
    // Founder and employee walls: refuse, zero retrieval, no elaboration.
    return refusedResponse(wall.sentence);
  }
  const opinionPrefix = wall?.wall === "opinion" ? wall.sentence : null;

  const intent = classifyIntent(question);
  let result: IntentResult | null;
  if (intent === "count") result = await countIntent(env, question);
  else if (intent === "trend") result = await trendIntent(env, question);
  else result = await topicIntent(env, question);

  // CITE-OR-REFUSE INVARIANT. No non-refused answer may ship with zero citations.
  // If an intent produced nothing citable, fall back to the honest no-results
  // shape, which always carries the methodology citation. This is the structural
  // guarantee that we never state a bare claim without a source.
  if (!result || result.citations.length === 0) {
    result = await noResults(env);
  }

  const tags = tagFor(question, intent, result.records);

  if (opinionPrefix) {
    if (result.isNoResults) {
      // Opinion asked but no relevant records to attach: refuse with the opinion
      // sentence only (rule 1c).
      return {
        answer: opinionPrefix,
        citations: [],
        tags,
        refused: true,
        disclosure: DISCLOSURE,
      };
    }
    result.answer = cap(opinionPrefix + " " + result.answer);
  }

  return {
    answer: result.answer,
    citations: result.citations,
    tags,
    refused: false,
    disclosure: DISCLOSURE,
  };
}
