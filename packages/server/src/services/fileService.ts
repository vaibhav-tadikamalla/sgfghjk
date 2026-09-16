import { query, withTransaction } from '../db/pool';
import { activityService } from './activityService';

export interface WorkspaceFile {
  id: string;
  name: string;
  folderId: string;
  lastEditedBy: string | null;
  lastEditedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface FileWithEditor extends WorkspaceFile {
  editorName: string | null;
}

export const fileService = {
  /** Create a new file in a folder. */
  async create(name: string, folderId: string, userId: string): Promise<WorkspaceFile> {
    const result = await query<{
      id: string;
      name: string;
      folder_id: string;
      last_edited_by: string | null;
      last_edited_at: string | null;
      created_at: string;
      updated_at: string;
      deleted_at: string | null;
    }>(
      `INSERT INTO files (name, folder_id) VALUES ($1, $2)
       RETURNING id, name, folder_id, last_edited_by, last_edited_at, created_at, updated_at, deleted_at`,
      [name, folderId],
    );
    const row = result.rows[0];
    await activityService.log(userId, 'file_created', 'file', row.id, { name, folderId });
    return mapFileRow(row);
  },

  /** List active (non-deleted) files in a folder. */
  async listInFolder(folderId: string): Promise<FileWithEditor[]> {
    const result = await query<{
      id: string;
      name: string;
      folder_id: string;
      last_edited_by: string | null;
      last_edited_at: string | null;
      created_at: string;
      updated_at: string;
      deleted_at: string | null;
      editor_name: string | null;
    }>(
      `SELECT f.id, f.name, f.folder_id, f.last_edited_by, f.last_edited_at,
              f.created_at, f.updated_at, f.deleted_at,
              u.display_name AS editor_name
       FROM files f
       LEFT JOIN users u ON u.id = f.last_edited_by
       WHERE f.folder_id = $1 AND f.deleted_at IS NULL
       ORDER BY f.updated_at DESC`,
      [folderId],
    );
    return result.rows.map((r) => ({ ...mapFileRow(r), editorName: r.editor_name }));
  },

  /** Soft-delete a file (move to trash). */
  async softDelete(fileId: string, userId: string): Promise<void> {
    await query(
      'UPDATE files SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL',
      [fileId],
    );
    await activityService.log(userId, 'file_deleted', 'file', fileId, {});
  },

  /** Restore a file from trash. */
  async restore(fileId: string, userId: string): Promise<void> {
    await query(
      'UPDATE files SET deleted_at = NULL WHERE id = $1',
      [fileId],
    );
    await activityService.log(userId, 'file_restored', 'file', fileId, {});
  },

  /** Permanently delete a file. */
  async permanentDelete(fileId: string): Promise<void> {
    await query('DELETE FROM files WHERE id = $1', [fileId]);
  },

  /** List trash (soft-deleted files) for a given folder. */
  async listTrash(folderId: string): Promise<WorkspaceFile[]> {
    const result = await query<{
      id: string;
      name: string;
      folder_id: string;
      last_edited_by: string | null;
      last_edited_at: string | null;
      created_at: string;
      updated_at: string;
      deleted_at: string | null;
    }>(
      `SELECT id, name, folder_id, last_edited_by, last_edited_at,
              created_at, updated_at, deleted_at
       FROM files
       WHERE folder_id = $1 AND deleted_at IS NOT NULL
       ORDER BY deleted_at DESC`,
      [folderId],
    );
    return result.rows.map(mapFileRow);
  },

  /** Get a single file by ID. */
  async getById(fileId: string): Promise<WorkspaceFile | null> {
    const result = await query<{
      id: string;
      name: string;
      folder_id: string;
      last_edited_by: string | null;
      last_edited_at: string | null;
      created_at: string;
      updated_at: string;
      deleted_at: string | null;
    }>(
      `SELECT id, name, folder_id, last_edited_by, last_edited_at,
              created_at, updated_at, deleted_at
       FROM files WHERE id = $1 AND deleted_at IS NULL`,
      [fileId],
    );
    if (result.rows.length === 0) return null;
    return mapFileRow(result.rows[0]);
  },

  /** Rename a file. */
  async rename(fileId: string, name: string, userId: string): Promise<WorkspaceFile> {
    const result = await query<{
      id: string;
      name: string;
      folder_id: string;
      last_edited_by: string | null;
      last_edited_at: string | null;
      created_at: string;
      updated_at: string;
      deleted_at: string | null;
    }>(
      `UPDATE files SET name = $1 WHERE id = $2
       RETURNING id, name, folder_id, last_edited_by, last_edited_at, created_at, updated_at, deleted_at`,
      [name, fileId],
    );
    if (result.rows.length === 0) throw new Error('FILE_NOT_FOUND');
    await activityService.log(userId, 'file_renamed', 'file', fileId, { name });
    return mapFileRow(result.rows[0]);
  },

  /** Save Yjs document state for a file. */
  async saveYdocState(fileId: string, state: Buffer): Promise<void> {
    await query(
      'UPDATE files SET ydoc_state = $1 WHERE id = $2',
      [state, fileId],
    );
  },

  /** Load Yjs document state for a file. */
  async loadYdocState(fileId: string): Promise<Buffer | null> {
    const result = await query<{ ydoc_state: Buffer | null }>(
      'SELECT ydoc_state FROM files WHERE id = $1',
      [fileId],
    );
    return result.rows[0]?.ydoc_state ?? null;
  },

  /** Update last edited metadata. */
  async updateLastEdited(fileId: string, userId: string): Promise<void> {
    await query(
      'UPDATE files SET last_edited_by = $1, last_edited_at = NOW() WHERE id = $2',
      [userId, fileId],
    );
  },
};

function mapFileRow(row: {
  id: string;
  name: string;
  folder_id: string;
  last_edited_by: string | null;
  last_edited_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}): WorkspaceFile {
  return {
    id: row.id,
    name: row.name,
    folderId: row.folder_id,
    lastEditedBy: row.last_edited_by,
    lastEditedAt: row.last_edited_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}
