import type { Env } from "../env.js";
import { getCursor, setCursor } from "../lib/config.js";

// Build record-to-record links for newly classified records. Incremental by a KV
// cursor over record id, capped hard per run for CPU and the 50-query budget.
//
// Query budget: one partner SELECT per source record plus a small number of
// INSERTs, so BATCH source records * (1 select + a few inserts) stays well under
// 50. BATCH and MAX_LINKS are deliberately small.

const BATCH = 4; // source records processed per run
const PARTNER_LIMIT = 12; // candidate partners fetched per source record
const MAX_LINKS = 24; // link inserts per run
const WINDOW_SECONDS = 90 * 24 * 60 * 60;

export type LinkType =
  | "same_carrier_promo"
  | "same_carrier_issue_window"
  | "same_promo_terms_language"
  | "same_claim_type";

interface RecordRow {
  id: number;
  carrier: string | null;
  promo_name: string | null;
  alleged_issue: string | null;
  ts: number;
}

// Decide which link types connect a source record to a candidate partner, given
// whether the shared promo name also appears in a terms diff. Pure, so it is
// tested directly.
export function linkTypesFor(
  src: RecordRow,
  cand: RecordRow,
  promoInTermsDiff: boolean
): Array<{ type: LinkType; basis: string }> {
  const out: Array<{ type: LinkType; basis: string }> = [];
  const sameCarrier = !!src.carrier && src.carrier === cand.carrier;
  const samePromo = !!src.promo_name && src.promo_name === cand.promo_name;
  const sameIssue = !!src.alleged_issue && src.alleged_issue === cand.alleged_issue;

  if (sameCarrier && samePromo) {
    out.push({ type: "same_carrier_promo", basis: `carrier=${src.carrier}; promo=${src.promo_name}` });
  }
  if (sameCarrier && sameIssue && Math.abs(src.ts - cand.ts) <= WINDOW_SECONDS) {
    out.push({
      type: "same_carrier_issue_window",
      basis: `carrier=${src.carrier}; issue=${src.alleged_issue}; within 90 days`,
    });
  }
  if (samePromo && promoInTermsDiff) {
    out.push({
      type: "same_promo_terms_language",
      basis: `promo="${src.promo_name}" appears in a carrier terms diff`,
    });
  }
  if (sameIssue) {
    out.push({ type: "same_claim_type", basis: `issue=${src.alleged_issue}` });
  }
  return out;
}

export async function runLinks(env: Env): Promise<{ processed: number; links: number }> {
  const cursor = await getCursor(env, "links_cursor", 0);
  const srcRows = await env.DB.prepare(
    `SELECT id, carrier, promo_name, alleged_issue, COALESCE(record_date, capture_date) AS ts
       FROM records
      WHERE id > ?1 AND carrier IS NOT NULL AND review_status IN ('cleared','queued')
      ORDER BY id
      LIMIT ?2`
  )
    .bind(cursor, BATCH)
    .all<RecordRow>();

  const promoDiffCache = new Map<string, boolean>();
  let maxId = cursor;
  let inserted = 0;

  for (const src of srcRows.results ?? []) {
    maxId = src.id;
    if (inserted >= MAX_LINKS) continue;

    const partners = await env.DB.prepare(
      `SELECT id, carrier, promo_name, alleged_issue, COALESCE(record_date, capture_date) AS ts
         FROM records
        WHERE id <> ?1
          AND ( (carrier = ?2 AND promo_name IS NOT NULL AND promo_name = ?3)
             OR (carrier = ?2 AND alleged_issue IS NOT NULL AND alleged_issue = ?4)
             OR (alleged_issue IS NOT NULL AND alleged_issue = ?4)
             OR (promo_name IS NOT NULL AND promo_name = ?3) )
        LIMIT ?5`
    )
      .bind(src.id, src.carrier, src.promo_name, src.alleged_issue, PARTNER_LIMIT)
      .all<RecordRow>();

    let promoInDiff = false;
    if (src.promo_name) {
      const cached = promoDiffCache.get(src.promo_name);
      if (cached === undefined) {
        promoInDiff = await promoAppearsInTermsDiff(env, src.promo_name);
        promoDiffCache.set(src.promo_name, promoInDiff);
      } else {
        promoInDiff = cached;
      }
    }

    for (const cand of partners.results ?? []) {
      if (inserted >= MAX_LINKS) break;
      const types = linkTypesFor(src, cand, promoInDiff);
      const [a, b] = src.id < cand.id ? [src.id, cand.id] : [cand.id, src.id];
      for (const t of types) {
        if (inserted >= MAX_LINKS) break;
        const out = await env.DB.prepare(
          `INSERT OR IGNORE INTO links (record_id_a, record_id_b, link_type, basis) VALUES (?1, ?2, ?3, ?4)`
        )
          .bind(a, b, t.type, t.basis)
          .run();
        inserted += out.meta.changes ?? 0;
      }
    }
  }

  if (maxId > cursor) await setCursor(env, "links_cursor", maxId);
  return { processed: (srcRows.results ?? []).length, links: inserted };
}

async function promoAppearsInTermsDiff(env: Env, promo: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS hit FROM terms_diffs WHERE diff LIKE ?1 LIMIT 1`)
    .bind(`%${promo}%`)
    .first<{ hit: number }>();
  return !!row;
}
