-- ================================================================
-- 003: Snapshot types, compression metadata, audit logging
-- ================================================================

-- Add snapshot_type to distinguish manual vs automatic snapshots
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'document_snapshots' AND column_name = 'snapshot_type'
  ) THEN
    ALTER TABLE document_snapshots
      ADD COLUMN snapshot_type TEXT NOT NULL DEFAULT 'manual'
        CHECK (snapshot_type IN ('manual', 'auto_compaction', 'auto_periodic', 'auto_restore'));
  END IF;
END $$;

-- Add compression metadata columns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'document_snapshots' AND column_name = 'compressed'
  ) THEN
    ALTER TABLE document_snapshots
      ADD COLUMN compressed BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'document_snapshots' AND column_name = 'raw_size_bytes'
  ) THEN
    ALTER TABLE document_snapshots
      ADD COLUMN raw_size_bytes INTEGER NOT NULL DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'document_snapshots' AND column_name = 'compressed_size_bytes'
  ) THEN
    ALTER TABLE document_snapshots
      ADD COLUMN compressed_size_bytes INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Add state_hash for deduplication (SHA-256 of raw ydoc_state)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'document_snapshots' AND column_name = 'state_hash'
  ) THEN
    ALTER TABLE document_snapshots
      ADD COLUMN state_hash TEXT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_snapshots_state_hash
  ON document_snapshots (document_id, state_hash);

-- ================================================================
-- AUDIT LOG
-- ================================================================
CREATE TABLE IF NOT EXISTS document_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('manual_snapshot', 'auto_snapshot', 'restore')),
  version_id UUID REFERENCES document_snapshots(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_document
  ON document_audit_log (document_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_action
  ON document_audit_log (action);
