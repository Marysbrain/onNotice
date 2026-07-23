-- Robust arbitration dollar statistics for aaa_arb records.
--
-- Migration 0008 summed raw consumer claim dollars. The first sweep proved that
-- raw sum is worthless as a public figure: it is dominated by absurd outlier asks
-- (a Verizon column sum of 59.6 billion dollars across 3,178 phone disputes,
-- against awards that average about 1,400 dollars). This migration replaces the
-- rollup and published tables with a schema that carries robust statistics:
--
--   * a CAPPED claim sum, adding only claims at or under $25,000 (2,500,000
--     cents; see CLAIM_CAP_CENTS in src/publish/claims.ts). Small-claims and
--     consumer arbitration matters realistically live at or below that ceiling.
--   * claims_above_cap: how many filings claimed MORE than the cap. These are
--     counted, never summed, so one billion-dollar ask can never inflate a total.
--   * a fixed power-of-two cent histogram (hb00..hb22) over the capped claims,
--     from which src/publish/claims.ts derives an APPROXIMATE median. Bucket 0
--     holds exactly-zero claims; bucket k (1..22) holds cents in [2^(k-1), 2^k).
--     The cap (2,500,000 < 2^22) guarantees no capped claim exceeds bucket 22, so
--     23 buckets cover the whole range with no overflow. The histogram is compact
--     fixed state, never per-row data.
--
-- The old raw claim/award sums are KEPT but renamed raw_* so nothing downstream
-- mistakes them for a shippable figure.
--
-- Both tables are DROPPED and recreated rather than altered: the columns and even
-- the meaning of the primary published figure change, so a clean slate is the
-- honest option. src/publish/claims.ts carries a SWEEP_GENERATION guard that, on
-- the first run after this deploys, also clears the KV cursor and stamps so a full
-- fresh sweep repopulates both tables from record id 0 with no manual surgery.
-- A full pass is 31 hourly runs (see the cadence note in claims.ts).

DROP TABLE IF EXISTS arb_claim_rollup;
DROP TABLE IF EXISTS arb_claim_published;

CREATE TABLE arb_claim_rollup (
  carrier                         TEXT PRIMARY KEY,
  cases                           INTEGER NOT NULL DEFAULT 0,
  -- Raw, unshippable sums kept only for audit. Never published as-is.
  raw_claim_consumer_total_cents  INTEGER NOT NULL DEFAULT 0,
  raw_claim_consumer_parsed_rows  INTEGER NOT NULL DEFAULT 0,
  raw_award_consumer_total_cents  INTEGER NOT NULL DEFAULT 0,
  raw_award_consumer_parsed_rows  INTEGER NOT NULL DEFAULT 0,
  -- Robust, shippable figures.
  claim_capped_total_cents        INTEGER NOT NULL DEFAULT 0,
  claim_capped_rows               INTEGER NOT NULL DEFAULT 0,
  claims_above_cap                INTEGER NOT NULL DEFAULT 0,
  -- Power-of-two cent histogram over capped claims (median source).
  hb00 INTEGER NOT NULL DEFAULT 0, hb01 INTEGER NOT NULL DEFAULT 0,
  hb02 INTEGER NOT NULL DEFAULT 0, hb03 INTEGER NOT NULL DEFAULT 0,
  hb04 INTEGER NOT NULL DEFAULT 0, hb05 INTEGER NOT NULL DEFAULT 0,
  hb06 INTEGER NOT NULL DEFAULT 0, hb07 INTEGER NOT NULL DEFAULT 0,
  hb08 INTEGER NOT NULL DEFAULT 0, hb09 INTEGER NOT NULL DEFAULT 0,
  hb10 INTEGER NOT NULL DEFAULT 0, hb11 INTEGER NOT NULL DEFAULT 0,
  hb12 INTEGER NOT NULL DEFAULT 0, hb13 INTEGER NOT NULL DEFAULT 0,
  hb14 INTEGER NOT NULL DEFAULT 0, hb15 INTEGER NOT NULL DEFAULT 0,
  hb16 INTEGER NOT NULL DEFAULT 0, hb17 INTEGER NOT NULL DEFAULT 0,
  hb18 INTEGER NOT NULL DEFAULT 0, hb19 INTEGER NOT NULL DEFAULT 0,
  hb20 INTEGER NOT NULL DEFAULT 0, hb21 INTEGER NOT NULL DEFAULT 0,
  hb22 INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE arb_claim_published (
  carrier                         TEXT PRIMARY KEY,
  cases                           INTEGER NOT NULL DEFAULT 0,
  raw_claim_consumer_total_cents  INTEGER NOT NULL DEFAULT 0,
  raw_claim_consumer_parsed_rows  INTEGER NOT NULL DEFAULT 0,
  raw_award_consumer_total_cents  INTEGER NOT NULL DEFAULT 0,
  raw_award_consumer_parsed_rows  INTEGER NOT NULL DEFAULT 0,
  claim_capped_total_cents        INTEGER NOT NULL DEFAULT 0,
  claim_capped_rows               INTEGER NOT NULL DEFAULT 0,
  claims_above_cap                INTEGER NOT NULL DEFAULT 0,
  hb00 INTEGER NOT NULL DEFAULT 0, hb01 INTEGER NOT NULL DEFAULT 0,
  hb02 INTEGER NOT NULL DEFAULT 0, hb03 INTEGER NOT NULL DEFAULT 0,
  hb04 INTEGER NOT NULL DEFAULT 0, hb05 INTEGER NOT NULL DEFAULT 0,
  hb06 INTEGER NOT NULL DEFAULT 0, hb07 INTEGER NOT NULL DEFAULT 0,
  hb08 INTEGER NOT NULL DEFAULT 0, hb09 INTEGER NOT NULL DEFAULT 0,
  hb10 INTEGER NOT NULL DEFAULT 0, hb11 INTEGER NOT NULL DEFAULT 0,
  hb12 INTEGER NOT NULL DEFAULT 0, hb13 INTEGER NOT NULL DEFAULT 0,
  hb14 INTEGER NOT NULL DEFAULT 0, hb15 INTEGER NOT NULL DEFAULT 0,
  hb16 INTEGER NOT NULL DEFAULT 0, hb17 INTEGER NOT NULL DEFAULT 0,
  hb18 INTEGER NOT NULL DEFAULT 0, hb19 INTEGER NOT NULL DEFAULT 0,
  hb20 INTEGER NOT NULL DEFAULT 0, hb21 INTEGER NOT NULL DEFAULT 0,
  hb22 INTEGER NOT NULL DEFAULT 0
);
