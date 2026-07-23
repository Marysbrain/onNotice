// Conservative money parsing for AAA arbitration excerpts.
//
// RULE 1 (real numbers only): an unparseable cell contributes zero and is
// counted as unparsed, never guessed. Every function here returns null rather
// than a best-guess number when the input is not unambiguously a dollar figure.
// Sums built on top of this can only ever undercount, never inflate, which is
// why the public aggregate carries "at least" language.

// parseDollars turns a single cell value into integer CENTS, or null.
//
// Returning cents (not floating dollars) keeps every downstream sum in exact
// integer arithmetic, so no rounding error can creep into a published total.
//
// Accepts: "$1,234.56" -> 123456, "1234" -> 123400, "1,234" -> 123400,
//          "0" -> 0, "$0.00" -> 0, "1234.5" -> 123450.
// Rejects (returns null): "", whitespace, "N/A", "-", "TBD", "1,23" (bad
//          thousands grouping), "1 234", negatives, and anything else that is
//          not cleanly a non-negative dollar amount.
export function parseDollars(cell: string): number | null {
  if (cell == null) return null;
  const t = cell.trim();
  if (t === "") return null;

  // One optional currency symbol, optional space, then either comma-grouped
  // thousands (1 to 3 digits, then groups of exactly 3) or a plain run of
  // digits, then an optional 1 or 2 digit fractional part. The whole cell must
  // match: a partial match is treated as garbage and rejected.
  const m = t.match(/^\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;

  const whole = m[1]!.replace(/,/g, "");
  const frac = (m[2] ?? "") + "00"; // pad so 1 digit becomes 2 (".5" -> 50c)
  const cents = Number(whole) * 100 + Number(frac.slice(0, 2));

  // Guard against silent precision loss on absurd inputs.
  return Number.isSafeInteger(cents) ? cents : null;
}

// extractExcerptField pulls one named column value out of an AAA record excerpt.
//
// Excerpts are stored as "Company | key1=value1; key2=value2; ..." and are
// TRUNCATED at 500 chars (see processors/parse-file.ts). Because of that
// truncation a target column may be absent (cut off entirely) or its value may
// be sliced mid-number. This function returns the raw value string when the key
// is present, or null when the key is missing. It never guesses. A value that
// survived truncation only partially is returned as-is and left to parseDollars,
// which rejects a malformed remnant; the worst case a surviving-but-shortened
// value can produce is an UNDERcount, which the "at least" phrasing covers.
export function extractExcerptField(excerpt: string, keys: string[]): string | null {
  // Split company off the head. The parser joins company and columns with " | "
  // exactly once, so the first occurrence is the boundary.
  const bar = excerpt.indexOf(" | ");
  const body = bar >= 0 ? excerpt.slice(bar + 3) : excerpt;

  const map = new Map<string, string>();
  for (const seg of body.split("; ")) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const k = seg.slice(0, eq).trim().toLowerCase();
    // Keep the raw value (parseDollars trims). First occurrence wins.
    if (!map.has(k)) map.set(k, seg.slice(eq + 1));
  }

  for (const key of keys) {
    const v = map.get(key.toLowerCase());
    if (v !== undefined) return v;
  }
  return null;
}

// The AAA columns we sum, as they appear lowercased in the excerpt. Kept as
// small alias lists so a minor header wording change does not silently drop a
// whole column, while never matching the business-party columns by mistake.
export const CLAIM_CONSUMER_KEYS = ["claim amt consumer", "claim amount consumer"];
export const AWARD_CONSUMER_KEYS = ["award amt consumer", "award amount consumer"];

// parseColumnCents extracts a named column from an excerpt and parses it to
// cents, or null if the column is absent or unparseable. This is the single unit
// the aggregate counts as "parsed": null means the row did not contribute.
export function parseColumnCents(excerpt: string, keys: string[]): number | null {
  const raw = extractExcerptField(excerpt, keys);
  if (raw === null) return null;
  return parseDollars(raw);
}

// Whole-dollar thousands formatting without depending on ICU/toLocaleString,
// which is not guaranteed to group in the Workers runtime. Rounds DOWN.
export function dollarsFloorGrouped(cents: number): string {
  const whole = Math.floor(cents / 100);
  return groupThousands(whole);
}

// Dollars rounded to the NEAREST $10, thousands-grouped. Used only for the
// approximate median in the /ask sentence: an approximate figure should not be
// printed to the dollar, so we snap it to the nearest ten and label it "near".
export function dollarsNearestTenGrouped(cents: number): string {
  const tens = Math.round(cents / 1000) * 10; // cents/100 dollars, /10 then *10
  return groupThousands(tens);
}

// Shared thousands grouper (no ICU dependency).
function groupThousands(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
