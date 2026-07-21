// Text normalization + a small line-level unified diff.
// The diff is a bounded LCS. Terms pages after normalization are a few hundred
// lines, well inside the 10ms free CPU budget. If either side is unexpectedly
// large we bail to a coarse diff so we never blow the budget.

// Normalize page text before hashing/diffing. Strip HTML, collapse whitespace,
// drop obvious volatile noise so cosmetic changes do not trip a false diff.
export function normalizeText(html: string): string {
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = noScript
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Drop cache-busting tokens and long digit runs that change every load.
  const cleaned = text.replace(/[?&](cb|t|_|v|nocache)=[^\s"']+/gi, " ");
  const lines = cleaned
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
  // Collapse consecutive duplicate lines. AT&T's trade-in page alternates
  // between rendering its text once and twice per load, which flip-flopped the
  // hash and produced a snapshot of identical content every day. The raw HTML
  // in R2 keeps whatever the page actually served.
  const out: string[] = [];
  for (const l of lines) {
    if (out[out.length - 1] !== l) out.push(l);
  }
  return out.join("\n");
}

const MAX_LCS_CELLS = 500_000;

export function unifiedDiff(
  oldText: string,
  newText: string,
  fromLabel = "old",
  toLabel = "new"
): string {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];

  if (a.length * b.length > MAX_LCS_CELLS) {
    return coarseDiff(a, b, fromLabel, toLabel);
  }

  // LCS table.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j]! = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const lines: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push(`- ${a[i]}`);
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < n) lines.push(`- ${a[i++]}`);
  while (j < m) lines.push(`+ ${b[j++]}`);
  return lines.join("\n");
}

// Fallback when inputs are too big for the LCS table. Set-based, order-blind.
function coarseDiff(a: string[], b: string[], fromLabel: string, toLabel: string): string {
  const aset = new Set(a);
  const bset = new Set(b);
  const removed = a.filter((l) => !bset.has(l));
  const added = b.filter((l) => !aset.has(l));
  const out: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`, "(coarse diff: inputs too large for line LCS)"];
  for (const l of removed) out.push(`- ${l}`);
  for (const l of added) out.push(`+ ${l}`);
  return out.join("\n");
}
