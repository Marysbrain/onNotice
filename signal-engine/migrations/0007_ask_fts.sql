-- Full-text search index for the /ask brain (Phase 4). FTS5 external-content
-- table over records.excerpt. It stores no copy of the text itself: the content
-- lives in records, and the virtual table's rowid maps to records.id. Triggers
-- keep the index in sync on every insert, update, and delete so a purged record
-- can never surface in an answer.

CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
  excerpt,
  content='records',
  content_rowid='id'
);

-- Keep the index current. The 'delete' command form is the FTS5 external-content
-- idiom for removing a row using the values that were indexed.
CREATE TRIGGER IF NOT EXISTS records_fts_ai AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(rowid, excerpt) VALUES (new.id, new.excerpt);
END;

CREATE TRIGGER IF NOT EXISTS records_fts_ad AFTER DELETE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, excerpt) VALUES ('delete', old.id, old.excerpt);
END;

CREATE TRIGGER IF NOT EXISTS records_fts_au AFTER UPDATE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, excerpt) VALUES ('delete', old.id, old.excerpt);
  INSERT INTO records_fts(rowid, excerpt) VALUES (new.id, new.excerpt);
END;

-- Backfill any rows that already exist at migration time.
INSERT INTO records_fts(rowid, excerpt) SELECT id, excerpt FROM records;
