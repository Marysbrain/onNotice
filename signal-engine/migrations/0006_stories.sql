-- Story submissions from the public form. Raw submissions are never displayed:
-- a human reviews, scrubs identifiers, and only then can a story become a
-- displayable record. contact is optional, never displayed, used only to
-- check facts with the submitter. No IP address, no user agent, on purpose.
CREATE TABLE IF NOT EXISTS stories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  what_happened TEXT NOT NULL,
  carrier       TEXT,                       -- att | verizon | tmobile | other | NULL
  city          TEXT,
  state         TEXT,                       -- USPS two letter
  zip           TEXT,
  contact       TEXT,                       -- optional, never displayed
  consent       INTEGER NOT NULL DEFAULT 0, -- 1 = the consent box was checked
  review_status TEXT NOT NULL DEFAULT 'queued', -- queued | approved | rejected | withdrawn
  review_note   TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_stories_review ON stories (review_status, created_at);
