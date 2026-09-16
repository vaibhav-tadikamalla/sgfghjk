-- ================================================================
-- 006_session_history
--
-- Persists completed WebSocket collaboration sessions for historical
-- reporting and per-user analytics.
--
-- One row is written per connection on disconnect (not per file-tab).
-- files_touched is a JSON array of string file IDs written to
-- during the session (may contain more than one element after
-- potential future file-switch support).
-- ================================================================

CREATE TABLE IF NOT EXISTS session_history (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL,
  workspace_id     UUID        NOT NULL,
  session_start    TIMESTAMPTZ NOT NULL,
  session_end      TIMESTAMPTZ NOT NULL,
  duration_seconds INTEGER     NOT NULL CHECK (duration_seconds >= 0),
  total_edits      INTEGER     NOT NULL DEFAULT 0 CHECK (total_edits >= 0),
  files_touched    JSONB       NOT NULL DEFAULT '[]',
  role             TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookups by user (e.g. "my recent sessions")
CREATE INDEX IF NOT EXISTS idx_session_history_user_id
  ON session_history (user_id);

-- Lookups by workspace (e.g. workspace activity report)
CREATE INDEX IF NOT EXISTS idx_session_history_workspace_id
  ON session_history (workspace_id);

-- Combined index for workspace + time range queries
CREATE INDEX IF NOT EXISTS idx_session_history_workspace_start
  ON session_history (workspace_id, session_start DESC);
