-- ================================================================
-- 009: Cluster topology + durable streams + presence
-- ================================================================
--
-- This migration adds schema support for the three final upgrades:
--   UPGRADE 1: Deterministic room ownership via consistent hashing
--   UPGRADE 2: Durable event log with Redis Streams (audit trail)
--   UPGRADE 3: Global presence & awareness service
--
-- NOTE: All three upgrades store their real-time state in Redis.
-- These PostgreSQL tables are purely for audit, recovery, and
-- observability — never queried in the hot path.
-- ================================================================

-- ── 1. Cluster topology event log ────────────────────────────────────────────
--
-- Records every cluster topology change (node join/leave/crash).
-- Used for post-mortem analysis, not real-time queries.

CREATE TABLE IF NOT EXISTS cluster_topology_log (
  id              BIGSERIAL    NOT NULL,
  event_type      TEXT         NOT NULL,  -- 'node_join' | 'node_leave' | 'node_crash'
  node_id         TEXT         NOT NULL,
  active_nodes    TEXT[]       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_cluster_topology_log PRIMARY KEY (id)
);

-- ── 2. Ownership transfer audit trail ────────────────────────────────────────
--
-- Records every room ownership transfer between nodes.
-- Useful for diagnosing rebalancing issues and measuring transfer latency.

CREATE TABLE IF NOT EXISTS ownership_transfer_log (
  id              BIGSERIAL    NOT NULL,
  room_id         TEXT         NOT NULL,
  from_node_id    TEXT         NOT NULL,
  to_node_id      TEXT         NOT NULL,
  transfer_ms     INTEGER,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_ownership_transfer_log PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_ownership_transfer_room
  ON ownership_transfer_log (room_id);

-- ── 3. Stream replay audit ───────────────────────────────────────────────────
--
-- Records stream replay events (pending entry recovery after reconnect).
-- Tracks how many entries were replayed and how long it took.

CREATE TABLE IF NOT EXISTS stream_replay_log (
  id              BIGSERIAL    NOT NULL,
  room_id         TEXT         NOT NULL,
  node_id         TEXT         NOT NULL,
  entries_replayed INTEGER     NOT NULL DEFAULT 0,
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_stream_replay_log PRIMARY KEY (id)
);

-- ── 4. Add stream_entry_id to document_updates for correlation ───────────────
--
-- Links WAL entries to Redis Stream entry IDs for cross-referencing
-- during crash recovery.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE  table_name  = 'document_updates'
    AND    column_name = 'stream_entry_id'
  ) THEN
    ALTER TABLE document_updates
      ADD COLUMN stream_entry_id TEXT;
  END IF;
END $$;
