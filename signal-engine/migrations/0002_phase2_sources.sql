-- Phase 2 collectors. Official-records and news-radar sources.
-- Enabled defaults are off for the API collectors so nothing hammers an API on
-- first deploy. FTC (seeded in 0001) and CA AG are the only enabled feeds.
-- Flip a source on with:
--   UPDATE sources SET enabled = 1 WHERE id = 'fcc_socrata';

INSERT OR IGNORE INTO sources (id, kind, display, url, enabled, rate_limit_ms) VALUES
  ('ca_ag_rss',  'ag_rss',    'California AG news RSS',        'https://oag.ca.gov/news/feed', 1, 2000),
  ('sec_edgar',  'edgar_fts', 'SEC EDGAR full-text search',   'https://efts.sec.gov/LATEST/search-index', 0, 6000),
  ('fcc_socrata','socrata',   'FCC consumer complaints (Socrata)', 'https://opendata.fcc.gov/resource/3xyp-aqkj.json', 0, 2000),
  ('fcc_ecfs',   'ecfs',      'FCC ECFS filings',             'https://publicapi.fcc.gov/ecfs/filings', 0, 4000),
  ('news_google','news_rss',  'Google News RSS radar',        'https://news.google.com/rss/search', 0, 3000),
  ('news_gdelt', 'news_api',  'GDELT DOC 2.0 radar',          'https://api.gdeltproject.org/api/v2/doc/doc', 0, 6000);
