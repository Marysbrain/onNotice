import type { Env } from "../env.js";
import { enabledSources, insertRecord, touchSource } from "../db/records.js";
import { matchCarrier, matchIssueTerms, searchPhrases } from "../lib/taxonomy.js";

// FCC ECFS filings. api.data.gov key required (secret ECFS_API_KEY), 1000/hr.
// We poll by taxonomy keyword, incremental by date_received.
//
// GUARDRAIL: filer names are stored only for organizations (law firms,
// companies, agencies, advocacy groups with a corporate suffix or org word).
// If the filer looks like a private individual, we store the filing id and a
// neutral excerpt but NOT the name, and we do not dump the raw comment body,
// which can contain personal information. When in doubt, no name.

const MAX_RECORDS_PER_RUN = 20;

// Strong corporate suffixes. A single matching token classifies as org.
const ORG_SUFFIX = new Set([
  "llc", "inc", "incorporated", "corp", "corporation", "co", "company",
  "ltd", "lp", "llp", "pllc", "plc", "gmbh", "pc",
]);

// Organization words. Whole-token match, so surnames like "Lawson" or "Grouper"
// do not trip "law" or "group".
const ORG_WORD = new Set([
  "association", "assn", "coalition", "committee", "commission", "council",
  "institute", "foundation", "university", "college", "department", "agency",
  "bureau", "alliance", "federation", "union", "systems", "communications",
  "networks", "network", "partners", "group", "center", "centre", "firm",
  "counsel", "attorneys", "telecom", "wireless", "broadband", "utilities",
]);

// Multiword phrases that signal an organization.
const ORG_PHRASE = [
  "on behalf of", "law firm", "law office", "law offices", "law group",
  "legal aid", "school district", "office of", "city of", "county of",
  "state of", "public utility", "public utilities", "public knowledge",
  "consumer law", "attorney general",
];

// Returns whether a filer name is an organization. Default false (no name)
// unless a positive org signal is present.
export function classifyFiler(name: string): { isOrg: boolean } {
  const lower = name.toLowerCase();
  for (const p of ORG_PHRASE) if (lower.includes(p)) return { isOrg: true };
  const tokens = lower.replace(/[.,&/()]/g, " ").split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (ORG_SUFFIX.has(t) || ORG_WORD.has(t)) return { isOrg: true };
  }
  return { isOrg: false };
}

export interface EcfsItem {
  id: string;
  dateReceived: string;
  filerName: string;
  textSnippet: string;
  proceedings: string;
}

export function parseEcfsFilings(json: unknown): EcfsItem[] {
  const filings = (json as { filings?: unknown[] })?.filings;
  if (!Array.isArray(filings)) return [];
  const items: EcfsItem[] = [];
  for (const f of filings) {
    const fil = f as Record<string, unknown>;
    const id = String(fil.id_submission ?? fil.id ?? "");
    if (!id) continue;
    const filers = Array.isArray(fil.filers) ? (fil.filers as Array<{ name?: string }>) : [];
    const filerName = filers[0]?.name ?? "";
    const proceedingsArr = Array.isArray(fil.proceedings) ? (fil.proceedings as Array<{ name?: string }>) : [];
    const proceedings = proceedingsArr.map((p) => p.name ?? "").filter(Boolean).join(", ");
    const raw = String(fil.text_data ?? fil.brief_comment_text ?? "");
    const textSnippet = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 280);
    items.push({
      id,
      dateReceived: String(fil.date_received ?? ""),
      filerName,
      textSnippet,
      proceedings,
    });
  }
  return items;
}

// Build a record excerpt. Individuals: neutral metadata plus matched taxonomy
// terms only, never the name or the raw body. Organizations: name plus a short
// snippet.
export function buildFilingExcerpt(item: EcfsItem, isOrg: boolean, matchedTerms: string[]): string {
  const base = `ECFS ${item.id} | proceeding ${item.proceedings || "n/a"} | ${item.dateReceived}`;
  const terms = matchedTerms.length ? ` | terms: ${matchedTerms.join(",")}` : "";
  if (isOrg && item.filerName) {
    return `${item.filerName} | ${base}${terms} | ${item.textSnippet}`.slice(0, 500);
  }
  return `${base}${terms} | individual filer, name withheld`.slice(0, 500);
}

export async function collectEcfs(env: Env): Promise<{ source: string; new: number; note?: string }[]> {
  if (!env.ECFS_API_KEY) {
    return [{ source: "fcc_ecfs", new: 0, note: "ECFS_API_KEY unset, skipped" }];
  }
  const sources = await enabledSources(env, "ecfs");
  const out: { source: string; new: number }[] = [];
  const phrases = searchPhrases();

  for (const src of sources) {
    const cursor = src.cursor || "";
    let added = 0;
    let maxDate = cursor;
    try {
      // One phrase per run, rotated by day, to stay gentle on the hourly cap.
      const phraseIdx = new Date().getUTCDate() % phrases.length;
      const phrase = phrases[phraseIdx]!;
      const url =
        `https://publicapi.fcc.gov/ecfs/filings?api_key=${encodeURIComponent(env.ECFS_API_KEY)}` +
        `&q=${encodeURIComponent(`"${phrase}"`)}&sort=date_received,DESC&limit=${MAX_RECORDS_PER_RUN}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "carriers-on-notice/0.1 (+contact@carriersonnotice.com)", Accept: "application/json" },
      });
      if (!res.ok) {
        out.push({ source: src.id, new: 0 });
        continue;
      }
      const items = parseEcfsFilings(await res.json());
      const capture = Math.floor(Date.now() / 1000);

      for (const item of items) {
        if (added >= MAX_RECORDS_PER_RUN) break;
        // Incremental: skip anything at or before the cursor date.
        if (cursor && item.dateReceived && item.dateReceived <= cursor) continue;
        if (item.dateReceived && item.dateReceived > maxDate) maxDate = item.dateReceived;

        const { isOrg } = classifyFiler(item.filerName);
        const searchText = `${item.filerName} ${item.textSnippet} ${item.proceedings}`;
        const matchedTerms = matchIssueTerms(searchText);
        const inserted = await insertRecord(env, {
          dedupeKey: `ecfs:${item.id}`,
          sourceId: src.id,
          sourceUrl: `https://www.fcc.gov/ecfs/search/search-filings/filing/${item.id}`,
          captureDate: capture,
          recordDate: item.dateReceived ? Math.floor(Date.parse(item.dateReceived) / 1000) : null,
          excerpt: buildFilingExcerpt(item, isOrg, matchedTerms),
          carrier: matchCarrier(searchText),
          vettingStatus: "single_source",
        });
        if (inserted) added++;
      }

      await touchSource(env, src.id, maxDate);
    } catch {
      // Drop this run. Cursor unchanged.
    }
    out.push({ source: src.id, new: added });
  }
  return out;
}
