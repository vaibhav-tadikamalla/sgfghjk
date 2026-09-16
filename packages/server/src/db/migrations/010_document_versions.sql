-- ================================================================
-- 010: Document Version History
-- ================================================================
--
-- Adds the ability to store, browse, diff, and restore previous
-- versions of documents.  Versions are captured at natural boundaries:
--
--   1. AUTO  — when the snapshotStore saves a compacted snapshot, a
--              version is captured if sufficient change has accumulated
--              (≥ 1 KB delta or ≥ 60 s since the last version).
--
--   2. NAMED — users create named checkpoints via the REST API.
--
-- Each version stores a complete V2-encoded Yjs state (same format
-- as document_snapshots).  Diffs between any two versions are computed
-- on demand via Y.diffUpdateV2 at query time.
--
-- Retention policy:
--   - Default: 100 versions per document, or 90 days — whichever comes first.
--   - Pruning runs lazily after each new auto-capture.
--
-- NOTE: The CRDT core is completely unaffected.  Version captures are
-- purely observational — they read the compacted Y.Doc state and store
-- a copy.  Restoring a version replays it as a normal Yjs update through
-- the existing write path, so all collaboration guarantees are preserved.
-- ================================================================

-- ── 1. document_versions ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS document_versions (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id       TEXT         NOT NULL,
  version_num   SERIAL,
  label         TEXT,                       -- null for auto-captured, user-provided for checkpoints
  source        TEXT         NOT NULL DEFAULT 'auto'
                             CHECK (source IN ('auto', 'manual', 'restore')),
  snapshot      BYTEA        NOT NULL,      -- V2-encoded Yjs state
  snapshot_hash TEXT         NOT NULL,      -- SHA-256 of snapshot bytes (deduplication)
  byte_size     INTEGER      NOT NULL,      -- pre-computed for UI / retention queries
  created_by    UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Primary read: list versions for a file, newest first
CREATE INDEX IF NOT EXISTS idx_versions_file_created
  ON document_versions (file_id, created_at DESC);

-- Deduplication guard: skip capture if hash hasn't changed
CREATE INDEX IF NOT EXISTS idx_versions_file_hash
  ON document_versions (file_id, snapshot_hash);

-- Retention pruning: find oldest versions per file
CREATE INDEX IF NOT EXISTS idx_versions_file_num
  ON document_versions (file_id, version_num ASC);

-- ── 2. Helper: count versions per file (for retention enforcement) ───────
-- No stored function needed — simple COUNT(*) + DELETE with LIMIT works.
