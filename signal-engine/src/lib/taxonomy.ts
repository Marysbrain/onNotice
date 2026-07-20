// Loads the checked-in taxonomy and exposes matchers. Taxonomy is data, not
// code. Track C extends taxonomy.json without touching this file.
import taxonomy from "../../taxonomy.json";

interface Carrier {
  id: string;
  display: string;
  patterns: string[];
  arb_respondent_patterns: string[];
  promo_names?: string[];
}

interface IssueTerm {
  id: string;
  term: string;
}

const carriers = taxonomy.carriers as Carrier[];
const issueTerms = taxonomy.issue_terms as IssueTerm[];

// Return the first carrier id whose display/marketing patterns appear in text.
export function matchCarrier(text: string): string | null {
  const hay = text.toLowerCase();
  for (const c of carriers) {
    if (c.patterns.some((p) => hay.includes(p.toLowerCase()))) return c.id;
  }
  return null;
}

// Every carrier id whose marketing patterns appear in text. Used by the
// deterministic tagger to detect the ambiguous multi-carrier case.
export function matchCarriersAll(text: string): string[] {
  const hay = text.toLowerCase();
  const ids: string[] = [];
  for (const c of carriers) {
    if (c.patterns.some((p) => hay.includes(p.toLowerCase()))) ids.push(c.id);
  }
  return ids;
}

// Literal promo-name hits, each tagged with the carrier that owns the name.
export function matchPromoNames(text: string): Array<{ carrierId: string; name: string }> {
  const hay = text.toLowerCase();
  const out: Array<{ carrierId: string; name: string }> = [];
  for (const c of carriers) {
    for (const n of c.promo_names ?? []) {
      if (hay.includes(n.toLowerCase())) out.push({ carrierId: c.id, name: n });
    }
  }
  return out;
}

// Return the carrier id whose arbitration respondent patterns match a company
// name cell from an AAA/JAMS file. Stricter list than marketing patterns.
export function matchArbRespondent(company: string): string | null {
  const hay = company.toLowerCase();
  for (const c of carriers) {
    if (c.arb_respondent_patterns.some((p) => hay.includes(p.toLowerCase()))) return c.id;
  }
  return null;
}

// Issue term ids present in text. Used to filter feeds and API results down to
// promo-credit topics before anything becomes a record.
export function matchIssueTerms(text: string): string[] {
  const hay = text.toLowerCase();
  const hits: string[] = [];
  for (const t of issueTerms) {
    if (hay.includes(t.term.toLowerCase())) hits.push(t.id);
  }
  return hits;
}

// True if text mentions a carrier or any promo-credit issue term.
export function hasTaxonomyMatch(text: string): boolean {
  return matchCarrier(text) !== null || matchIssueTerms(text).length > 0;
}

// Promo names for a carrier, used by Track C. Empty if none seeded.
export function promoNamesFor(carrierId: string): string[] {
  return carriers.find((c) => c.id === carrierId)?.promo_names ?? [];
}

// A small set of representative search phrases for building outbound queries
// (news, EDGAR, ECFS). Quoted phrases, kept short so query strings stay small.
export function searchPhrases(): string[] {
  return [
    "bill credits",
    "trade-in credit",
    "promotional credit",
    "credit clawback",
    "36 monthly bill credits",
  ];
}

export function carrierList(): Carrier[] {
  return carriers;
}
