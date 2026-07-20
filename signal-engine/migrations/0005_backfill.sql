-- Historical backfill layer. Additive. Nothing here runs until a backfill job is
-- triggered by hand or a source is enabled.

-- FCC complaint volume as monthly aggregates, NOT row-level complaints. The
-- architecture decision: the public FCC dataset has no carrier field, so we only
-- ever need concentration by place and month. One row per (month, state, zip,
-- method). zip is null for state-level rows; state may be null for zip-level rows.
CREATE TABLE IF NOT EXISTS fcc_monthly_aggregates (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  month   TEXT NOT NULL,           -- YYYY-MM
  state   TEXT,                    -- two-letter, or null on zip-level rows
  zip     TEXT,                    -- zip, or null on state-level rows
  method  TEXT,                    -- method of contact, or null
  count   INTEGER NOT NULL,
  UNIQUE (month, state, zip, method)
);
CREATE INDEX IF NOT EXISTS idx_fcc_month ON fcc_monthly_aggregates (month);
CREATE INDEX IF NOT EXISTS idx_fcc_state ON fcc_monthly_aggregates (state);
CREATE INDEX IF NOT EXISTS idx_fcc_zip ON fcc_monthly_aggregates (zip);

-- Backfill sources. Disabled by default. The arbitration and terms/Wayback
-- backfills reuse existing source rows (aaa_arb, jams_arb, terms_*).
INSERT OR IGNORE INTO sources (id, kind, display, url, enabled, rate_limit_ms) VALUES
  ('ftc_backfill',   'ftc_backfill',   'FTC press release history',   'https://www.ftc.gov/news-events/news/press-releases', 0, 3000),
  ('courtlistener',  'courtlistener',  'CourtListener v4 search',      'https://www.courtlistener.com/api/rest/v4/search/', 0, 12000),
  ('fcc_aggregate',  'fcc_aggregate',  'FCC monthly aggregates (Socrata)', 'https://opendata.fcc.gov/resource/3xyp-aqkj.json', 0, 2000);
