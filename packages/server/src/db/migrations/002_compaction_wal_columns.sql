ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS compaction_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS wal_entries BYTEA[] NOT NULL DEFAULT '{}';

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS size_bytes INTEGER NOT NULL DEFAULT 0;

UPDATE documents
SET size_bytes = COALESCE(octet_length(ydoc_state), 0)
WHERE size_bytes = 0;

CREATE INDEX IF NOT EXISTS idx_documents_compaction_version
  ON documents (compaction_version);
