-- Phase 3. Social listeners: Bluesky and Hacker News, plus deletion honoring
-- and the publishable aggregate view.

-- Track when each social record was last re-resolved. Null sorts first in the
-- purge queue, so new rows get verified soon after insertion.
ALTER TABLE records ADD COLUMN last_checked_at INTEGER;

-- Both listeners ship disabled so nothing polls on first deploy. Enable with:
--   UPDATE sources SET enabled = 1 WHERE id IN ('bluesky','hackernews');
INSERT OR IGNORE INTO sources (id, kind, display, url, enabled, rate_limit_ms) VALUES
  ('bluesky',    'bsky', 'Bluesky public post search', 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts', 0, 3000),
  ('hackernews', 'hn',   'Hacker News (Algolia)',      'https://hn.algolia.com/api/v1/search_by_date', 0, 3000);

-- Publishable aggregate: mentions per carrier per month per source. Counts only
-- rows that currently exist. The purge jobs hard-delete removed social posts, so
-- this stays honest. Track E's methodology page points here.
-- month is derived from the event date (record_date) when known, else the
-- capture date.
CREATE VIEW IF NOT EXISTS v_carrier_mentions_monthly AS
  SELECT
    source_id,
    carrier,
    strftime('%Y-%m', datetime(COALESCE(record_date, capture_date), 'unixepoch')) AS month,
    COUNT(*) AS mentions
  FROM records
  WHERE carrier IS NOT NULL
  GROUP BY source_id, carrier, month;
