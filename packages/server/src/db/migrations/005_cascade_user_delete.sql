-- ================================================================
-- Fix FK constraints so deleting a user doesn't cause FK violations.
-- Tables with CASCADE already: refresh_tokens, documents, document_permissions,
-- folders, folder_permissions, edit_sessions.
-- Tables that need updating: share_tokens, document_snapshots, assets,
-- comments, export_jobs, files.last_edited_by
-- ================================================================

-- share_tokens.created_by → SET NULL
ALTER TABLE share_tokens DROP CONSTRAINT IF EXISTS share_tokens_created_by_fkey;
ALTER TABLE share_tokens ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE share_tokens ADD CONSTRAINT share_tokens_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- share_tokens.redeemed_by → SET NULL (already nullable)
ALTER TABLE share_tokens DROP CONSTRAINT IF EXISTS share_tokens_redeemed_by_fkey;
ALTER TABLE share_tokens ADD CONSTRAINT share_tokens_redeemed_by_fkey
  FOREIGN KEY (redeemed_by) REFERENCES users(id) ON DELETE SET NULL;

-- document_snapshots.created_by → SET NULL (already nullable)
ALTER TABLE document_snapshots DROP CONSTRAINT IF EXISTS document_snapshots_created_by_fkey;
ALTER TABLE document_snapshots ADD CONSTRAINT document_snapshots_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- assets.uploaded_by → SET NULL
ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_uploaded_by_fkey;
ALTER TABLE assets ALTER COLUMN uploaded_by DROP NOT NULL;
ALTER TABLE assets ADD CONSTRAINT assets_uploaded_by_fkey
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL;

-- comments.author_id → SET NULL
ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_author_id_fkey;
ALTER TABLE comments ALTER COLUMN author_id DROP NOT NULL;
ALTER TABLE comments ADD CONSTRAINT comments_author_id_fkey
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL;

-- comments.resolved_by → SET NULL (already nullable)
ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_resolved_by_fkey;
ALTER TABLE comments ADD CONSTRAINT comments_resolved_by_fkey
  FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL;

-- export_jobs.requested_by → SET NULL
ALTER TABLE export_jobs DROP CONSTRAINT IF EXISTS export_jobs_requested_by_fkey;
ALTER TABLE export_jobs ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_requested_by_fkey
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL;

-- files.last_edited_by → SET NULL (already nullable)
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_last_edited_by_fkey;
ALTER TABLE files ADD CONSTRAINT files_last_edited_by_fkey
  FOREIGN KEY (last_edited_by) REFERENCES users(id) ON DELETE SET NULL;

-- document_permissions.granted_by → SET NULL (already nullable)
ALTER TABLE document_permissions DROP CONSTRAINT IF EXISTS document_permissions_granted_by_fkey;
ALTER TABLE document_permissions ADD CONSTRAINT document_permissions_granted_by_fkey
  FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL;
