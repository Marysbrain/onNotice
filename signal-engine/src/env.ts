// Worker bindings. Names match wrangler.jsonc.
export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  CONFIG: KVNamespace;
  // Workers AI binding. Used by the default classifier (Track C).
  AI: Ai;

  // Non-secret vars.
  ENVIRONMENT: string;

  // Secrets. Set with `wrangler secret put`. Optional. Absent in dev.
  // Guards the manual /run endpoint.
  ADMIN_TOKEN?: string;
  // Wayback Save Page Now S3 credentials. If unset, SPN is skipped gracefully.
  WAYBACK_ACCESS_KEY?: string;
  WAYBACK_SECRET_KEY?: string;

  // SEC fair-access User-Agent, format "CompanyName email". Required by SEC.
  // No default that looks real. If unset, the EDGAR collector skips.
  SEC_USER_AGENT?: string;
  // Socrata app token. Optional. Raises the FCC dataset throttle. Works without.
  SOCRATA_APP_TOKEN?: string;
  // api.data.gov key for FCC ECFS. Required by ECFS. If unset, ECFS skips.
  ECFS_API_KEY?: string;

  // Anthropic key for the optional Haiku classifier via AI Gateway. COST FLAG:
  // Haiku bills per token. If unset, the classifier stays on Workers AI.
  ANTHROPIC_API_KEY?: string;

  // Optional CourtListener API token. Raises rate limits. The backfill works
  // without it, inside the free 125/day budget.
  COURTLISTENER_TOKEN?: string;
}
