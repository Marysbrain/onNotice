import type { Env } from "../env.js";

// The publishable aggregate: mentions per carrier per month per source, counting
// only rows that still exist. The purge jobs hard-delete removed social posts,
// so "still exist" stays honest. Track E's methodology page points at this.
//
// The view v_carrier_mentions_monthly is defined in migration 0003.

export interface CarrierMonthlyMention {
  source_id: string | null;
  carrier: string;
  month: string; // YYYY-MM
  mentions: number;
}

export async function getCarrierMentionsMonthly(env: Env): Promise<CarrierMonthlyMention[]> {
  const res = await env.DB.prepare(
    `SELECT source_id, carrier, month, mentions
       FROM v_carrier_mentions_monthly
      ORDER BY month DESC, carrier ASC, source_id ASC`
  ).all<CarrierMonthlyMention>();
  return res.results ?? [];
}
