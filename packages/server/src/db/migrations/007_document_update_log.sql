-- ================================================================
-- 007: Durable update log for zero-data-loss crash recovery
-- ================================================================
--
-- Architecture overview:
--
--   Before this migration:
--     client → Y.Doc (in-memory) → snapshotQueue (in-memory)
--                                  → document_snapshots (PostgreSQL)
--     CRASH WINDOW: updates between snapshot flushes are lost.
--
--   After this migration:
--     client → Y.Doc (in-memory) → document_updates  (PostgreSQL, IMMEDIATE)
--                                → snapshotQueue     (in-memory / coalesced)
--                                → document_snapshots (PostgreSQL, periodic)
--     CRASH WINDOW: none.  document_updates is the WAL.
--
-- Recovery flow:
--   1. Load document_snapshots (snapshot + snapshot_seq watermark).
--   2. SELECT * FROM document_updates WHERE doc_id = $1 AND id > snapshot_seq
--      ORDER BY id ASC  →  replay each entry via Y.applyUpdate.
--   3. The merged Y.Doc is the exact pre-crash state.
--
-- Pruning:
--   After every successful snapshot write, snapshot_seq is updated to the
--   highest document_updates.id that is incorporated.  All rows with
--   id <= snapshot_seq are then deleted, keeping the table bounded.
-- ================================================================

-- ── 1. document_snapshots: add watermark column ───────────────────────────────
--
-- The live-snapshot table used by snapshotStore.ts already exists.
-- We CREATE TABLE IF NOT EXISTS so this migration is safe whether the table
-- was previously created via an un-numbered DDL or this is the first run.
-- The subsequent ADD COLUMN is idempotent via the DO-block guard.

CREATE TABLE IF NOT EXISTS document_snapshots (
  file_id     TEXT        PRIMARY KEY,
  snapshot    BYTEA       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE  table_name  = 'document_snapshots'
    AND    column_name = 'snapshot_seq'
  ) THEN
    -- snapshot_seq: the highest document_updates.id whose content is already
    -- incorporated into this snapshot.  Used to bound update log replay.
    ALTER TABLE document_snapshots
      ADD COLUMN snapshot_seq BIGINT NOT NULL DEFAULT 0;
  END IF;
END $$;

-- ── 2. document_updates: append-only Yjs update log ──────────────────────────
--
-- One row per raw Yjs binary update received from any client.
-- Written synchronously before the broadcast so it survives any crash.
-- Pruned after each successful snapshot compaction.

CREATE TABLE IF NOT EXISTS document_updates (
  id          BIGSERIAL    NOT NULL,
  doc_id      TEXT         NOT NULL,
  update_data BYTEA        NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT  pk_document_updates PRIMARY KEY (id)
);

-- Primary read pattern: WHERE doc_id = $1 AND id > $2 ORDER BY id ASC
-- This covers both recovery replay and pruning DELETE WHERE id <= $2.
CREATE INDEX IF NOT EXISTS idx_document_updates_doc_seq
  ON document_updates (doc_id, id ASC);

-- Secondary: retention queries by age (e.g. "delete updates older than 30d")
CREATE INDEX IF NOT EXISTS idx_document_updates_created_at
  ON document_updates (created_at);
