import { describe, it, expect } from "vitest";
import {
  parseDollars,
  extractExcerptField,
  parseColumnCents,
  dollarsFloorGrouped,
  CLAIM_CONSUMER_KEYS,
  AWARD_CONSUMER_KEYS,
} from "../src/ask/money.js";

describe("parseDollars conservative parsing", () => {
  // Values that must parse, in integer cents.
  const good: Array<[string, number]> = [
    ["$1,234.56", 123456],
    ["1234", 123400],
    ["1,234", 123400],
    ["0", 0],
    ["$0.00", 0],
    ["1234.5", 123450],
    ["$5,000", 500000],
    ["$ 1,234.56", 123456], // space after the currency symbol
    ["  42  ", 4200], // surrounding whitespace is trimmed
    ["1,000,000", 100000000],
  ];
  for (const [input, cents] of good) {
    it(`parses ${JSON.stringify(input)} to ${cents} cents`, () => {
      expect(parseDollars(input)).toBe(cents);
    });
  }

  // Values that must return null (unparseable => contributes zero, counted unparsed).
  const bad = ["", "   ", "N/A", "-", "TBD", "1,23", "1 234", "-50", "$", "$.", "abc", "1.234", "12,34"];
  for (const input of bad) {
    it(`rejects ${JSON.stringify(input)} as null`, () => {
      expect(parseDollars(input)).toBeNull();
    });
  }

  it("never returns a negative or NaN for any tested input", () => {
    for (const [input] of good) {
      const v = parseDollars(input)!;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe("extractExcerptField over the AAA excerpt shape", () => {
  const ex =
    "AT&T Mobility LLC | case id=123; nonconsumer=AT&T Mobility LLC; " +
    "claim amt consumer=$1,234.56; claim amt business=$0.00; " +
    "award amt consumer=$500.00; filing date=02-JUN-21";

  it("pulls the consumer claim column, not the business column", () => {
    expect(extractExcerptField(ex, CLAIM_CONSUMER_KEYS)).toBe("$1,234.56");
  });

  it("pulls the consumer award column", () => {
    expect(extractExcerptField(ex, AWARD_CONSUMER_KEYS)).toBe("$500.00");
  });

  it("returns null when the column is absent (truncated off)", () => {
    const truncated = "AT&T Mobility LLC | case id=123; nonconsumer=AT&T Mobility LLC; claim amt consu";
    expect(extractExcerptField(truncated, CLAIM_CONSUMER_KEYS)).toBeNull();
    expect(parseColumnCents(truncated, CLAIM_CONSUMER_KEYS)).toBeNull();
  });

  it("a truncated dollar remnant parses to null, never a wrong number", () => {
    // "$1,23" is a malformed thousands group, so parseDollars rejects it.
    const cut = "AT&T Mobility LLC | claim amt consumer=$1,23";
    expect(extractExcerptField(cut, CLAIM_CONSUMER_KEYS)).toBe("$1,23");
    expect(parseColumnCents(cut, CLAIM_CONSUMER_KEYS)).toBeNull();
  });

  it("parseColumnCents returns cents for a clean cell", () => {
    expect(parseColumnCents(ex, CLAIM_CONSUMER_KEYS)).toBe(123456);
    expect(parseColumnCents(ex, AWARD_CONSUMER_KEYS)).toBe(50000);
  });
});

describe("dollarsFloorGrouped rounds down and groups thousands", () => {
  it("floors cents to whole dollars", () => {
    expect(dollarsFloorGrouped(123456)).toBe("1,234");
    expect(dollarsFloorGrouped(99)).toBe("0");
    expect(dollarsFloorGrouped(100000000)).toBe("1,000,000");
    expect(dollarsFloorGrouped(0)).toBe("0");
  });
});
