// Month cursor helpers. Months are strings "YYYY-MM", which sort and compare
// correctly as strings, so cursor walking is a plain string comparison.

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Socrata floating-timestamp boundaries for a month, half-open [start, end).
export function monthStartISO(month: string): string {
  return `${month}-01T00:00:00.000`;
}
export function monthEndISO(month: string): string {
  return `${addMonths(month, 1)}-01T00:00:00.000`;
}
