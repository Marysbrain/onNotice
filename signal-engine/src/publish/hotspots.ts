import type { Env } from "../env.js";
import { sumByState } from "../db/fcc.js";

// Hot spot ranking. Concentration comes from the FCC monthly aggregates
// (complaint volume by state) boosted by vetted-record density, so a state with
// verified reports ranks above one with only raw complaint noise. Output feeds
// aggregates/hotspots.json; the map's flames read that file.

const RECORD_BOOST = 50; // each vetted record counts like this many complaints

export interface StateSignal {
  state: string;
  fccCount: number;
  recordCount: number;
}

export interface Hotspot {
  state: string;
  intensity: number; // 0..1, relative to the hottest state
  basis: string;
}

// Pure ranking. Score is complaint volume plus boosted record density; intensity
// is the score normalized to the top state.
export function rankHotspots(signals: StateSignal[], topN = 10): Hotspot[] {
  const scored = signals.map((s) => ({ ...s, score: s.fccCount + s.recordCount * RECORD_BOOST }));
  const max = scored.reduce((m, s) => Math.max(m, s.score), 0) || 1;
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((s) => ({
      state: s.state,
      intensity: Math.round((s.score / max) * 1000) / 1000,
      basis: `${s.fccCount.toLocaleString("en-US")} FCC phone complaints, ${s.recordCount} vetted report(s)`,
    }));
}

export async function gatherStateSignals(env: Env): Promise<StateSignal[]> {
  const fcc = await sumByState(env);
  const fccMap = new Map(fcc.map((r) => [r.state, r.count]));

  const recs = await env.DB.prepare(
    `SELECT loc_state AS state, COUNT(*) AS count
       FROM records
      WHERE review_status = 'cleared'
        AND vetting_status IN ('corroborated','verified_primary')
        AND loc_state IS NOT NULL
      GROUP BY loc_state`
  ).all<{ state: string; count: number }>();
  const recMap = new Map((recs.results ?? []).map((r) => [r.state, r.count]));

  const states = new Set<string>([...fccMap.keys(), ...recMap.keys()]);
  const out: StateSignal[] = [];
  for (const state of states) {
    out.push({ state, fccCount: fccMap.get(state) ?? 0, recordCount: recMap.get(state) ?? 0 });
  }
  return out;
}

export async function computeHotspots(env: Env, topN = 10): Promise<Hotspot[]> {
  return rankHotspots(await gatherStateSignals(env), topN);
}
