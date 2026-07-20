import { matchCarriersAll, matchPromoNames, matchIssueTerms } from "../lib/taxonomy.js";

// Deterministic first pass. Cheap, no model. Resolves only the unambiguous case:
// exactly one carrier is implied (by a marketing pattern or a promo-name literal).
// Anything ambiguous (more than one carrier) or empty is left for the AI stage.
//
// Deterministic-certain gets confidence 0.95, never 1.0. Machine tagging is not
// verification, and the schema keeps that honest: this pass never touches
// vetting_status.

export interface TagResult {
  carrier: string | null;
  promoName: string | null;
  allegedIssue: string | null;
  confidence: number | null;
  resolved: boolean; // true means no AI stage needed
  ambiguous: boolean; // more than one carrier implied
}

export function deterministicClassify(text: string): TagResult {
  const carriersFromText = matchCarriersAll(text);
  const promoMatches = matchPromoNames(text);
  const issues = matchIssueTerms(text);

  const carrierSet = new Set<string>([...carriersFromText, ...promoMatches.map((p) => p.carrierId)]);

  if (carrierSet.size === 1) {
    const carrier = [...carrierSet][0]!;
    const promoNames = [...new Set(promoMatches.map((p) => p.name))];
    return {
      carrier,
      promoName: promoNames.length === 1 ? promoNames[0]! : null,
      allegedIssue: issues[0] ?? null,
      confidence: 0.95,
      resolved: true,
      ambiguous: false,
    };
  }

  // Zero carriers, or more than one: hand it to the AI stage.
  return {
    carrier: null,
    promoName: null,
    allegedIssue: issues[0] ?? null,
    confidence: null,
    resolved: false,
    ambiguous: carrierSet.size > 1,
  };
}
