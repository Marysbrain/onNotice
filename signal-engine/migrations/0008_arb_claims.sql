-- Arbitration dollar aggregation for aaa_arb records.
--
-- Excerpt parsing (regex over "$1,234.56") cannot run in SQL, so it happens in
-- the Worker, in bounded batches spread across publish runs (see
-- src/publish/claims.ts). Two tables keep that honest:
--
--   arb_claim_rollup     the sweep currently in progress. Batches accumulate
--                        here. Numbers here are partial and never published.
--   arb_claim_published  the last COMPLETED sweep. claims.json is built from
--                        this table only, so the public numbers never show a
--                        half-summed, growing-then-resetting total.
--
-- A sweep walks eligible aaa_arb records by id. When it reaches the end, the
-- rollup is copied to published and cleared, and the id cursor resets. Only
-- cleared + corroborated-or-better records are summed (RULE 4).
--
-- Both tables carry, per carrier: case count, consumer claim cents + how many
-- rows parsed, consumer award cents + how many rows parsed. parsed_rows <= cases
-- always, because a truncated or unparseable dollar cell contributes zero and is
-- simply not counted as parsed.

CREATE TABLE IF NOT EXISTS arb_claim_rollup (
  carrier                     TEXT PRIMARY KEY,
  cases                       INTEGER NOT NULL DEFAULT 0,
  claim_consumer_total_cents  INTEGER NOT NULL DEFAULT 0,
  claim_consumer_parsed_rows  INTEGER NOT NULL DEFAULT 0,
  award_consumer_total_cents  INTEGER NOT NULL DEFAULT 0,
  award_consumer_parsed_rows  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS arb_claim_published (
  carrier                     TEXT PRIMARY KEY,
  cases                       INTEGER NOT NULL DEFAULT 0,
  claim_consumer_total_cents  INTEGER NOT NULL DEFAULT 0,
  claim_consumer_parsed_rows  INTEGER NOT NULL DEFAULT 0,
  award_consumer_total_cents  INTEGER NOT NULL DEFAULT 0,
  award_consumer_parsed_rows  INTEGER NOT NULL DEFAULT 0
);
