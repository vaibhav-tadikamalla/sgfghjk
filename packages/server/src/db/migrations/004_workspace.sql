-- ================================================================
-- WORKSPACE: Folders + Files + Permissions + Activity + Edit Tracking
-- ================================================================

-- Folders
CREATE TABLE IF NOT EXISTS folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_folders_owner ON folders (owner_id);

-- Folder-level permissions
CREATE TABLE IF NOT EXISTS folder_permissions (
  folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (folder_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_folder_perms_user ON folder_permissions (user_id);
CREATE INDEX IF NOT EXISTS idx_folder_perms_folder ON folder_permissions (folder_id);

-- Files
CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  ydoc_state BYTEA,
  last_edited_by UUID REFERENCES users(id),
  last_edited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ  -- soft delete
);

CREATE INDEX IF NOT EXISTS idx_files_folder ON files (folder_id);
CREATE INDEX IF NOT EXISTS idx_files_deleted ON files (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_name_search ON files USING gin (to_tsvector('english', name));

-- Edit sessions
CREATE TABLE IF NOT EXISTS edit_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  edits_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_edit_sessions_file ON edit_sessions (file_id);
CREATE INDEX IF NOT EXISTS idx_edit_sessions_user ON edit_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_edit_sessions_active ON edit_sessions (file_id, user_id) WHERE ended_at IS NULL;

-- Activity logs
CREATE TABLE IF NOT EXISTS activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('folder', 'file')),
  entity_id UUID NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_logs (user_id, created_at DESC);

-- Triggers
CREATE OR REPLACE TRIGGER trigger_folders_updated_at
  BEFORE UPDATE ON folders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trigger_files_updated_at
  BEFORE UPDATE ON files
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
