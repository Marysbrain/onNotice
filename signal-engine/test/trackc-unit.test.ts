import { describe, it, expect } from "vitest";
import { deterministicClassify } from "../src/classify/tagger.js";
import { coerceResult } from "../src/classify/classifier.js";
import { windowHasTwoSources } from "../src/classify/corroborate.js";
import { linkTypesFor } from "../src/classify/links.js";

const DAY = 24 * 60 * 60;

describe("deterministic tagger", () => {
  it("resolves a single named carrier at 0.95 confidence", () => {
    const r = deterministicClassify("AT&T removed my bill credits after six months");
    expect(r.resolved).toBe(true);
    expect(r.carrier).toBe("att");
    expect(r.confidence).toBe(0.95);
    expect(r.allegedIssue).toBe("bill_credits");
    expect(r.ambiguous).toBe(false);
  });

  it("infers the carrier from a promo-name literal", () => {
    const r = deterministicClassify("the keep and switch offer never paid out");
    expect(r.resolved).toBe(true);
    expect(r.carrier).toBe("tmobile");
    expect(r.promoName).toBe("keep and switch");
  });

  it("routes multi-carrier ambiguity to the AI stage", () => {
    const r = deterministicClassify("comparing AT&T and Verizon trade-in credit offers");
    expect(r.resolved).toBe(false);
    expect(r.ambiguous).toBe(true);
    expect(r.carrier).toBe(null);
  });

  it("routes empty (no carrier) to the AI stage", () => {
    const r = deterministicClassify("just some unrelated text");
    expect(r.resolved).toBe(false);
    expect(r.ambiguous).toBe(false);
  });
});

describe("coerceResult", () => {
  it("extracts a JSON object and validates the carrier", () => {
    const out = coerceResult('noise {"carrier":"att","promo_name":"next up","alleged_issue":"x","confidence":0.8,"rationale":"named"} tail');
    expect(out.carrier).toBe("att");
    expect(out.confidence).toBe(0.8);
    expect(out.promo_name).toBe("next up");
  });

  it("drops a carrier that is not in the taxonomy", () => {
    const out = coerceResult('{"carrier":"sprint","confidence":0.9}');
    expect(out.carrier).toBe(null);
  });

  it("falls back to zero confidence on unparseable output", () => {
    const out = coerceResult("the model said no");
    expect(out.confidence).toBe(0);
    expect(out.carrier).toBe(null);
  });
});

describe("corroboration window", () => {
  it("two different sources within 90 days qualifies", () => {
    expect(
      windowHasTwoSources([
        { source_id: "bluesky", ts: 1000 },
        { source_id: "hackernews", ts: 1000 + 10 * DAY },
      ])
    ).toBe(true);
  });

  it("the same source twice does not qualify", () => {
    expect(
      windowHasTwoSources([
        { source_id: "bluesky", ts: 1000 },
        { source_id: "bluesky", ts: 1000 + 10 * DAY },
      ])
    ).toBe(false);
  });

  it("two different sources more than 90 days apart does not qualify", () => {
    expect(
      windowHasTwoSources([
        { source_id: "bluesky", ts: 1000 },
        { source_id: "hackernews", ts: 1000 + 120 * DAY },
      ])
    ).toBe(false);
  });
});

describe("linkTypesFor", () => {
  const base = { id: 1, carrier: "att", promo_name: "next up", alleged_issue: "bill_credits", ts: 1000 };

  it("same carrier and promo yields same_carrier_promo", () => {
    const types = linkTypesFor(base, { id: 2, carrier: "att", promo_name: "next up", alleged_issue: null, ts: 1000 }, false);
    expect(types.map((t) => t.type)).toContain("same_carrier_promo");
    expect(types.find((t) => t.type === "same_carrier_promo")!.basis).toContain("promo=next up");
  });

  it("same carrier and issue within 90 days yields same_carrier_issue_window", () => {
    const near = { id: 3, carrier: "att", promo_name: null, alleged_issue: "bill_credits", ts: 1000 + 10 * DAY };
    const far = { id: 4, carrier: "att", promo_name: null, alleged_issue: "bill_credits", ts: 1000 + 200 * DAY };
    expect(linkTypesFor(base, near, false).map((t) => t.type)).toContain("same_carrier_issue_window");
    expect(linkTypesFor(base, far, false).map((t) => t.type)).not.toContain("same_carrier_issue_window");
  });

  it("shared promo in a terms diff yields same_promo_terms_language only when flagged", () => {
    const cand = { id: 5, carrier: "verizon", promo_name: "next up", alleged_issue: null, ts: 1000 };
    expect(linkTypesFor(base, cand, true).map((t) => t.type)).toContain("same_promo_terms_language");
    expect(linkTypesFor(base, cand, false).map((t) => t.type)).not.toContain("same_promo_terms_language");
  });

  it("same issue across carriers yields same_claim_type", () => {
    const cand = { id: 6, carrier: "verizon", promo_name: null, alleged_issue: "bill_credits", ts: 1000 };
    expect(linkTypesFor(base, cand, false).map((t) => t.type)).toContain("same_claim_type");
  });
});
