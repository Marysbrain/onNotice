-- Carriers On Notice signal engine. Initial schema.
-- SQLite / D1. Times are unix epoch seconds unless noted.

-- ---------------------------------------------------------------------------
-- sources: registry mirror. One row per collector source. Drives enable flags
-- and cursor state (last-seen link, last file hash, etc). Seed rows below.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,          -- stable slug, e.g. ftc_rss_press
  kind          TEXT NOT NULL,             -- rss | arb_file | terms_page
  display       TEXT NOT NULL,
  url           TEXT,                       -- feed URL or landing page or target page
  enabled       INTEGER NOT NULL DEFAULT 1, -- 0 disables the collector for this row
  cursor        TEXT,                       -- free-form JSON cursor state per source
  rate_limit_ms INTEGER NOT NULL DEFAULT 1000,
  last_run_at   INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ---------------------------------------------------------------------------
-- jobs: the pipeline backbone. Collectors write work rows. Stage workers claim
-- and process them on the cron. Idempotent: (type, dedupe_key) is unique so
-- INSERT OR IGNORE makes re-enqueue a no-op.
--   status: pending -> claimed -> done | dead
--   retry:  on failure we flip back to pending and push scheduled_at forward.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL,              -- parse_file | ...
  dedupe_key   TEXT NOT NULL,              -- natural key. one job per (type, key)
  payload      TEXT NOT NULL DEFAULT '{}', -- JSON args for the processor
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  scheduled_at INTEGER NOT NULL DEFAULT (unixepoch()), -- not runnable before this
  claimed_at   INTEGER,
  error        TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs (type, dedupe_key);
-- Claim query filters on status + scheduled_at + orders by id. This index serves it.
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (status, scheduled_at, id);

-- ---------------------------------------------------------------------------
-- records: the evidence rows. Carries every field Track C classification needs.
-- Location is city/state/zip only. Never a full address, never a person.
-- Idempotent on dedupe_key (usually source_url or provider row id).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS records (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key     TEXT NOT NULL,            -- unique natural key for this record
  source_id      TEXT,                     -- FK-ish to sources.id (not enforced)
  source_url     TEXT NOT NULL,            -- where it came from
  capture_date   INTEGER NOT NULL,         -- when we collected it
  record_date    INTEGER,                  -- date of the underlying event, if known
  excerpt        TEXT NOT NULL,            -- short quoted snapshot, no full copy
  archive_url    TEXT,                     -- Wayback SPN url or R2 pointer

  -- Track C fields. Collectors leave most null. Classifier fills them.
  carrier        TEXT,                     -- att | verizon | tmobile | null
  promo_name     TEXT,
  alleged_issue  TEXT,
  loc_city       TEXT,
  loc_state      TEXT,
  loc_zip        TEXT,
  confidence     REAL,                     -- 0..1, set by Track C

  -- Vetting. Only verified_primary and corroborated may feed public numbers.
  vetting_status TEXT NOT NULL DEFAULT 'single_source',
                 -- verified_primary | corroborated | single_source | disputed
  review_status  TEXT NOT NULL DEFAULT 'unrouted',
                 -- unrouted | queued | in_review | cleared | rejected
  review_reason  TEXT,

  raw_ref        TEXT,                      -- R2 key of the raw item if stored
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_dedupe ON records (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_records_carrier ON records (carrier);
CREATE INDEX IF NOT EXISTS idx_records_review ON records (review_status);
CREATE INDEX IF NOT EXISTS idx_records_vetting ON records (vetting_status);

-- ---------------------------------------------------------------------------
-- terms_snapshots: one row per successful capture of a target terms/promo page.
-- Raw HTML lives in R2 at r2_key. content_hash is over normalized text so
-- cosmetic changes do not trip a diff.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS terms_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  target       TEXT NOT NULL,             -- sources.id of the terms page
  url          TEXT NOT NULL,
  r2_key       TEXT NOT NULL,             -- raw HTML in R2
  content_hash TEXT NOT NULL,             -- sha-256 hex of normalized text
  archive_url  TEXT,                       -- Wayback SPN url if captured
  captured_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_snap_target ON terms_snapshots (target, captured_at);

-- ---------------------------------------------------------------------------
-- terms_diffs: one row when a target's normalized hash changed vs the prior
-- snapshot. diff is a unified text diff, old -> new.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS terms_diffs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  target       TEXT NOT NULL,
  from_snap_id INTEGER,                    -- terms_snapshots.id, prior
  to_snap_id   INTEGER NOT NULL,          -- terms_snapshots.id, new
  from_hash    TEXT,
  to_hash      TEXT NOT NULL,
  diff         TEXT NOT NULL,             -- unified diff text
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_diffs_target ON terms_diffs (target, created_at);

-- ---------------------------------------------------------------------------
-- Seed the sources registry. Enabled flags default on for phase 1 collectors.
-- Terms page URLs are placeholders. Fill real target URLs at deploy (see README).
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO sources (id, kind, display, url, enabled, rate_limit_ms) VALUES
  ('ftc_rss_press',    'rss',       'FTC press release RSS',            'https://www.ftc.gov/feeds/press-release.xml', 1, 2000),
  ('ftc_rss_consumer', 'rss',       'FTC consumer protection RSS',      'https://www.ftc.gov/feeds/press-release-consumer-protection.xml', 1, 2000),
  ('aaa_arb',          'arb_file',  'AAA consumer arbitration file',    'https://www.adr.org/ConsumerArbitrationStatistics', 1, 5000),
  ('jams_arb',         'arb_file',  'JAMS consumer case file',          'https://www.jamsadr.com/consumercases', 1, 5000),
  ('terms_att_promo',  'terms_page','AT&T promo/offer terms (placeholder)',    'https://www.att.com/REPLACE_WITH_REAL_TERMS_URL', 1, 3000),
  ('terms_vzw_promo',  'terms_page','Verizon promo/offer terms (placeholder)', 'https://www.verizon.com/REPLACE_WITH_REAL_TERMS_URL', 1, 3000),
  ('terms_tmo_promo',  'terms_page','T-Mobile promo/offer terms (placeholder)','https://www.t-mobile.com/REPLACE_WITH_REAL_TERMS_URL', 1, 3000);
