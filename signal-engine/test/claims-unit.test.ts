import { describe, it, expect } from "vitest";
import {
  parseDollars,
  extractExcerptField,
  parseColumnCents,
  dollarsFloorGrouped,
  dollarsNearestTenGrouped,
  CLAIM_CONSUMER_KEYS,
  AWARD_CONSUMER_KEYS,
} from "../src/ask/money.js";
import {
  CLAIM_CAP_CENTS,
  HIST_BUCKETS,
  claimBucket,
  histMedianCents,
} from "../src/publish/claims.js";

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

describe("dollarsNearestTenGrouped snaps to the nearest ten dollars", () => {
  it("rounds to the nearest $10 and groups thousands", () => {
    expect(dollarsNearestTenGrouped(131072)).toBe("1,310"); // $1,310.72 -> $1,310
    expect(dollarsNearestTenGrouped(50000)).toBe("500"); // exactly $500
    expect(dollarsNearestTenGrouped(45)).toBe("0"); // $0.45 -> $0
    expect(dollarsNearestTenGrouped(2_500_000)).toBe("25,000"); // the cap
  });
});

describe("claimBucket: power-of-two cent buckets", () => {
  it("puts zero in bucket 0 and small values in low buckets", () => {
    expect(claimBucket(0)).toBe(0);
    expect(claimBucket(1)).toBe(1); // [2^0, 2^1)
    expect(claimBucket(2)).toBe(2); // [2^1, 2^2)
    expect(claimBucket(3)).toBe(2);
    expect(claimBucket(4)).toBe(3); // [2^2, 2^3)
  });

  it("keeps the cap inside the last bucket and never overflows", () => {
    // 2,500,000 < 2^22 = 4,194,304, so the cap sits in bucket 22, the last one.
    expect(claimBucket(CLAIM_CAP_CENTS)).toBe(22);
    expect(claimBucket(CLAIM_CAP_CENTS)).toBeLessThanOrEqual(HIST_BUCKETS - 1);
    // A value at 2^21 (a bucket boundary) is exact, no floating-point drift.
    expect(claimBucket(2 ** 21)).toBe(22);
    expect(claimBucket(2 ** 21 - 1)).toBe(21);
  });
});

describe("histMedianCents: approximate median from the histogram", () => {
  // Bucket k>=1 spans [2^(k-1), 2^k), so its width is 2^(k-1) cents. The exact
  // median and the interpolated estimate share the same bucket, so the estimate is
  // within that width of the truth (and within a factor of two).
  function bucketWidth(k: number): number {
    return k <= 0 ? 1 : 2 ** (k - 1);
  }
  function histOf(centsValues: number[]): number[] {
    const h = new Array(HIST_BUCKETS).fill(0);
    for (const c of centsValues) h[claimBucket(c)] += 1;
    return h;
  }
  function exactMedian(values: number[]): number {
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  }

  it("returns null for an empty histogram", () => {
    expect(histMedianCents(new Array(HIST_BUCKETS).fill(0))).toBeNull();
  });

  it("lands within one bucket width of the true median for seeded values", () => {
    const values = [10000, 20000, 40000, 80000, 160000]; // exact median 40000
    const approx = histMedianCents(histOf(values))!;
    const exact = exactMedian(values); // 40000
    const width = bucketWidth(claimBucket(exact)); // bucket 16 -> 32768
    expect(approx).not.toBeNull();
    expect(Math.abs(approx - exact)).toBeLessThanOrEqual(width);
    // And within a factor of two, the documented worst-case bound.
    expect(approx).toBeGreaterThan(exact / 2);
    expect(approx).toBeLessThan(exact * 2);
  });

  it("a single capped value yields a median inside that value's bucket", () => {
    const value = 50000; // bucket 16: [32768, 65536)
    const approx = histMedianCents(histOf([value]))!;
    expect(approx).toBeGreaterThanOrEqual(2 ** 15);
    expect(approx).toBeLessThan(2 ** 16);
  });

  it("all-zero claims give a median at or near zero", () => {
    const approx = histMedianCents(histOf([0, 0, 0]))!;
    expect(approx).toBeGreaterThanOrEqual(0);
    expect(approx).toBeLessThanOrEqual(1);
  });
});
