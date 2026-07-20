import type { Env } from "../env.js";

// FCC monthly aggregate rows. Insert is multi-row and chunked so a whole month
// of state or top-zip counts lands in a few D1 statements, well under the
// 50-queries-per-invocation free limit.

export interface FccAggRow {
  month: string;
  state: string | null;
  zip: string | null;
  method: string | null;
  count: number;
}

const ROWS_PER_STATEMENT = 20; // 5 params each = 100, the D1 bound-param cap

export async function insertFccMonthly(env: Env, rows: FccAggRow[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
    const placeholders = chunk
      .map((_, k) => `(?${k * 5 + 1}, ?${k * 5 + 2}, ?${k * 5 + 3}, ?${k * 5 + 4}, ?${k * 5 + 5})`)
      .join(", ");
    const binds = chunk.flatMap((r) => [r.month, r.state, r.zip, r.method, r.count]);
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO fcc_monthly_aggregates (month, state, zip, method, count) VALUES ${placeholders}`
    )
      .bind(...binds)
      .run();
    inserted += res.meta.changes ?? 0;
  }
  return inserted;
}

export async function sumByState(env: Env): Promise<Array<{ state: string; count: number }>> {
  const res = await env.DB.prepare(
    `SELECT state, SUM(count) AS count FROM fcc_monthly_aggregates
      WHERE state IS NOT NULL GROUP BY state ORDER BY count DESC`
  ).all<{ state: string; count: number }>();
  return res.results ?? [];
}

export async function sumByZip(env: Env, limit = 1000): Promise<Array<{ zip: string; count: number }>> {
  const res = await env.DB.prepare(
    `SELECT zip, SUM(count) AS count FROM fcc_monthly_aggregates
      WHERE zip IS NOT NULL GROUP BY zip ORDER BY count DESC LIMIT ?1`
  )
    .bind(limit)
    .all<{ zip: string; count: number }>();
  return res.results ?? [];
}

export async function monthlyTrendByState(env: Env, state: string): Promise<Array<{ month: string; count: number }>> {
  const res = await env.DB.prepare(
    `SELECT month, SUM(count) AS count FROM fcc_monthly_aggregates
      WHERE state = ?1 GROUP BY month ORDER BY month ASC`
  )
    .bind(state)
    .all<{ month: string; count: number }>();
  return res.results ?? [];
}
