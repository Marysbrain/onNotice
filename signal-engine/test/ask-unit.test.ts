import { describe, it, expect } from "vitest";
import { checkWall } from "../src/ask/walls.js";
import { classifyIntent, buildFtsQuery, sourceCategory } from "../src/ask/router.js";
import { tagFor } from "../src/ask/tags.js";

describe("founder / personal-case wall", () => {
  const phrasings = [
    "Tell me about Michael Hipp's AT&T dispute",
    "What is the founder's settlement with the carrier?",
    "Did your creator have a problem with his carrier?",
    "What happened with the guy who runs this site and AT&T?",
    "What's the personal case behind this website?",
  ];
  for (const q of phrasings) {
    it(`refuses hard: ${q}`, () => {
      const w = checkWall(q);
      expect(w?.wall).toBe("founder");
      expect(w?.hard).toBe(true);
      expect(w?.sentence).toContain("personal matters");
    });
  }
});

describe("individual-employee wall", () => {
  const phrasings = [
    "Who is the AT&T rep that lied to me?",
    "Name the store manager who sold me the plan",
    "Which employee at Verizon handled the clawback?",
    "Can you tell me the name of the salesperson?",
    "Who is the customer service agent I talked to?",
    "Name a specific worker responsible for this",
  ];
  for (const q of phrasings) {
    it(`refuses hard: ${q}`, () => {
      const w = checkWall(q);
      expect(w?.wall).toBe("employee");
      expect(w?.hard).toBe(true);
      expect(w?.sentence).toContain("never individual employees");
    });
  }
});

describe("opinion wall", () => {
  const phrasings = [
    "What do you think about AT&T?",
    "Is it fair what Verizon did?",
    "Do you hate T-Mobile?",
    "In your opinion, are these carriers evil?",
  ];
  for (const q of phrasings) {
    it(`flags soft: ${q}`, () => {
      const w = checkWall(q);
      expect(w?.wall).toBe("opinion");
      expect(w?.hard).toBe(false);
      expect(w?.sentence).toContain("The commentary on this site is Michael's");
    });
  }
});

describe("wall precedence and non-hits", () => {
  it("founder beats employee when both could match", () => {
    const w = checkWall("name the employee who is the founder of this");
    expect(w?.wall).toBe("founder");
  });
  it("lets a clean topical question through", () => {
    expect(checkWall("Did AT&T remove bill credits after a trade-in?")).toBe(null);
  });
  it("lets the count question through", () => {
    expect(checkWall("How many AT&T issues are in the library?")).toBe(null);
  });
});

describe("intent router", () => {
  it("detects count", () => {
    expect(classifyIntent("How many AT&T issues are in the library?")).toBe("count");
    expect(classifyIntent("What is the number of Verizon records?")).toBe("count");
  });
  it("detects trend", () => {
    expect(classifyIntent("Has AT&T improved?")).toBe("trend");
    expect(classifyIntent("Did T-Mobile get worse over time?")).toBe("trend");
  });
  it("defaults to topic", () => {
    expect(classifyIntent("Did AT&T claw back trade-in credits?")).toBe("topic");
    expect(classifyIntent("best pizza in Denver")).toBe("topic");
  });
});

describe("source category mapping", () => {
  it("buckets arbitration, court, and regulator/press", () => {
    expect(sourceCategory("aaa_arb")).toBe("arbitration");
    expect(sourceCategory("jams_arb")).toBe("arbitration");
    expect(sourceCategory("courtlistener")).toBe("court");
    expect(sourceCategory("ftc_backfill")).toBe("regulator_press");
    expect(sourceCategory("ca_ag_rss")).toBe("regulator_press");
    expect(sourceCategory(null)).toBe("regulator_press");
  });
});

describe("FTS query builder", () => {
  it("strips stopwords and question words, joins with OR", () => {
    // "AT&T" tokenizes to "at" (stopword) and "t" (one char, dropped).
    expect(buildFtsQuery("How many bill credits did AT&T claw back?")).toBe("bill OR credits OR claw OR back");
  });
  it("dedupes and drops one-char and generic corpus tokens", () => {
    // 'records' and 'issue' are dropped as generic corpus words.
    expect(buildFtsQuery("records of the clawback issue clawback")).toBe("clawback");
  });
  it("returns empty when nothing meaningful remains", () => {
    expect(buildFtsQuery("what are the issues?")).toBe("");
  });
  it("keeps only safe alphanumeric tokens (no FTS operators can leak)", () => {
    expect(buildFtsQuery('"clawback" AND (credits)')).toBe("clawback OR credits");
  });
});

describe("deterministic tagger", () => {
  it("takes carrier from the question and negative sentiment from a harm term", () => {
    const t = tagFor("Did AT&T clawback my credits?", "topic", []);
    expect(t.carrier).toBe("att");
    expect(t.sentiment).toBe("negative");
  });
  it("falls back to the dominant carrier of the records", () => {
    const t = tagFor("what changed with the offer", "topic", [
      { carrier: "verizon", excerpt: "verizon promo" },
      { carrier: "verizon", excerpt: "verizon again" },
      { carrier: "att", excerpt: "att once" },
    ]);
    expect(t.carrier).toBe("verizon");
  });
  it("stays neutral with no harm terms and no carrier", () => {
    const t = tagFor("what promotions exist", "topic", []);
    expect(t.carrier).toBe(null);
    expect(t.sentiment).toBe("neutral");
  });
  it("sets topic to the first matched issue term id", () => {
    const t = tagFor("questions about the trade-in credit", "topic", []);
    expect(t.topic).toBe("trade_in_credit");
  });
});
