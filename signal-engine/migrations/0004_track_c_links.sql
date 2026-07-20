-- Track C connection layer. Record-to-record links that Track E renders as
-- exploration threads. Additive: no existing table is changed.
--
-- link_type is one of the documented rabbit-hole kinds:
--   same_carrier_promo          same carrier and same promo_name
--   same_carrier_issue_window   same carrier and same alleged_issue within 90 days
--   same_promo_terms_language   shared promo_name that also appears in a terms diff
--   same_claim_type             same alleged_issue, any carrier
--
-- basis states the shared value in plain text so Track E can show why two dots
-- connect. record_id_a is always the smaller id, so each pair is stored once.
CREATE TABLE IF NOT EXISTS links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id_a INTEGER NOT NULL,
  record_id_b INTEGER NOT NULL,
  link_type   TEXT NOT NULL,
  basis       TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (record_id_a, record_id_b, link_type)
);
CREATE INDEX IF NOT EXISTS idx_links_a ON links (record_id_a);
CREATE INDEX IF NOT EXISTS idx_links_b ON links (record_id_b);
