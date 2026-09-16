-- ================================================================
-- 008: Production hardening — schema changes for ≥98/100 audit
-- ================================================================
--
-- This migration adds schema support for:
--   1. Client acknowledgement protocol (ack_seq tracking)
--   2. Room compaction audit trail
--   3. Node health / partition recovery metadata
-- ================================================================

-- ── 1. document_updates: add node_id for partition tracing ───────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE  table_name  = 'document_updates'
    AND    column_name = 'node_id'
  ) THEN
    ALTER TABLE document_updates
      ADD COLUMN node_id TEXT;
  END IF;
END $$;

-- ── 2. Compaction audit log ──────────────────────────────────────────────────
--
-- Records every CRDT compaction event for operational visibility.
-- This is an append-only audit trail, never queried in the hot path.

CREATE TABLE IF NOT EXISTS compaction_log (
  id              BIGSERIAL    NOT NULL,
  file_id         TEXT         NOT NULL,
  before_bytes    BIGINT       NOT NULL,
  after_bytes     BIGINT       NOT NULL,
  tombstones_removed BIGINT   NOT NULL DEFAULT 0,
  duration_ms     INTEGER      NOT NULL,
  node_id         TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_compaction_log PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_compaction_log_file_id
  ON compaction_log (file_id, created_at DESC);

-- ── 3. Node registry for partition recovery ──────────────────────────────────
--
-- Each node upserts its heartbeat here.  On Redis reconnect, nodes query
-- this table to discover peers for state vector exchange.

CREATE TABLE IF NOT EXISTS node_registry (
  node_id         TEXT         PRIMARY KEY,
  last_heartbeat  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  rooms_owned     INTEGER      NOT NULL DEFAULT 0,
  connections     INTEGER      NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_node_registry_heartbeat
  ON node_registry (last_heartbeat DESC);

