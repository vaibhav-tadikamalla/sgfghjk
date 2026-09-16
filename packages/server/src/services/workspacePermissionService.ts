import { query } from '../db/pool';

export type WorkspaceRole = 'owner' | 'editor' | 'viewer';

/**
 * Callback invoked after a permission change is committed to the DB.
 * (folderId, userId) — the collaboration server uses these to close any live
 * connections that are no longer authorised.
 */
type PermissionChangeHook = (folderId: string, userId: string) => void;
let _permissionChangeHook: PermissionChangeHook | null = null;

/**
 * Register a hook that fires after every revokeRole or role-downgrade-to-viewer.
 * Intended to be called once at startup by the collaboration layer.
 */
export function setPermissionChangeHook(hook: PermissionChangeHook): void {
  _permissionChangeHook = hook;
}

/**
 * Folder-level permission service.
 * Permissions cascade from folder to all files within it.
 */
export const permissionService = {
  /** Get the user's role for a folder, or null if none. */
  async getRole(folderId: string, userId: string): Promise<WorkspaceRole | null> {
    const result = await query<{ role: WorkspaceRole }>(
      'SELECT role FROM folder_permissions WHERE folder_id = $1 AND user_id = $2',
      [folderId, userId],
    );
    return result.rows[0]?.role ?? null;
  },

  /** Check if user can read (any role). */
  async canRead(folderId: string, userId: string): Promise<boolean> {
    const role = await this.getRole(folderId, userId);
    return role !== null;
  },

  /** Check if user can write (owner or editor). */
  async canWrite(folderId: string, userId: string): Promise<boolean> {
    const role = await this.getRole(folderId, userId);
    return role === 'owner' || role === 'editor';
  },

  /** Check if user is the owner. */
  async isOwner(folderId: string, userId: string): Promise<boolean> {
    const role = await this.getRole(folderId, userId);
    return role === 'owner';
  },

  /** Get the folder_id for a given file, used to check file-level permissions.
   *  Excludes soft-deleted files to prevent WS access to trashed files. */
  async getFolderIdForFile(fileId: string): Promise<string | null> {
    const result = await query<{ folder_id: string }>(
      'SELECT folder_id FROM files WHERE id = $1 AND deleted_at IS NULL',
      [fileId],
    );
    return result.rows[0]?.folder_id ?? null;
  },

  /** Get the user's role for a file (via its folder). */
  async getRoleForFile(fileId: string, userId: string): Promise<WorkspaceRole | null> {
    const folderId = await this.getFolderIdForFile(fileId);
    if (!folderId) return null;
    return this.getRole(folderId, userId);
  },

  /** Check if user can read a file. */
  async canReadFile(fileId: string, userId: string): Promise<boolean> {
    const folderId = await this.getFolderIdForFile(fileId);
    if (!folderId) return false;
    return this.canRead(folderId, userId);
  },

  /** Check if user can write a file. */
  async canWriteFile(fileId: string, userId: string): Promise<boolean> {
    const folderId = await this.getFolderIdForFile(fileId);
    if (!folderId) return false;
    return this.canWrite(folderId, userId);
  },

  /** Grant a role to a user for a folder (upsert). */
  async grantRole(folderId: string, userId: string, role: WorkspaceRole): Promise<void> {
    await query(
      `INSERT INTO folder_permissions (folder_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (folder_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, granted_at = NOW()`,
      [folderId, userId, role],
    );
    // Downgrading an active editor/owner to viewer must close their live connections
    if (role === 'viewer') {
      _permissionChangeHook?.(folderId, userId);
    }
  },

  /** Remove a user's permission for a folder. */
  async revokeRole(folderId: string, userId: string): Promise<void> {
    await query(
      'DELETE FROM folder_permissions WHERE folder_id = $1 AND user_id = $2',
      [folderId, userId],
    );
    // Fire after DB commit so the WS layer sees a consistent permission state
    _permissionChangeHook?.(folderId, userId);
  },

  /** List all permissions for a folder. */
  async listPermissions(folderId: string): Promise<Array<{
    userId: string;
    role: WorkspaceRole;
    displayName: string;
    email: string;
    grantedAt: string;
  }>> {
    const result = await query<{
      user_id: string;
      role: WorkspaceRole;
      display_name: string;
      email: string;
      granted_at: string;
    }>(
      `SELECT fp.user_id, fp.role, u.display_name, u.email, fp.granted_at
       FROM folder_permissions fp
       JOIN users u ON u.id = fp.user_id
       WHERE fp.folder_id = $1
       ORDER BY fp.granted_at`,
      [folderId],
    );
    return result.rows.map((r) => ({
      userId: r.user_id,
      role: r.role,
      displayName: r.display_name,
      email: r.email,
      grantedAt: r.granted_at,
    }));
  },
};
