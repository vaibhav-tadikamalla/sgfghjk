-- Add paste event counters for reviewer visibility metrics
ALTER TABLE edit_sessions
  ADD COLUMN IF NOT EXISTS paste_events_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_edit_sessions_paste_events
  ON edit_sessions (paste_events_count)
  WHERE paste_events_count > 0;
