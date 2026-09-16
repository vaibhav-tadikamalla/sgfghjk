import { query, withTransaction } from '../db/pool';
import { permissionService } from './workspacePermissionService';
import { activityService } from './activityService';

export interface Folder {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface FolderWithRole extends Folder {
  role: string;
}

export const folderService = {
  /** Create a folder and assign owner permission. */
  async create(name: string, ownerId: string): Promise<Folder> {
    return withTransaction(async (client) => {
      const result = await client.query<{
        id: string;
        name: string;
        owner_id: string;
        created_at: string;
        updated_at: string;
      }>(
        `INSERT INTO folders (name, owner_id) VALUES ($1, $2)
         RETURNING id, name, owner_id, created_at, updated_at`,
        [name, ownerId],
      );
      const row = result.rows[0];

      // Auto-assign owner permission
      await client.query(
        `INSERT INTO folder_permissions (folder_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [row.id, ownerId],
      );

      // Log activity
      await activityService.logWithClient(client, ownerId, 'folder_created', 'folder', row.id, { name });

      return {
        id: row.id,
        name: row.name,
        ownerId: row.owner_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  },

  /** List all folders accessible to a user. */
  async listForUser(userId: string): Promise<FolderWithRole[]> {
    const result = await query<{
      id: string;
      name: string;
      owner_id: string;
      created_at: string;
      updated_at: string;
      role: string;
    }>(
      `SELECT f.id, f.name, f.owner_id, f.created_at, f.updated_at, fp.role
       FROM folders f
       JOIN folder_permissions fp ON fp.folder_id = f.id
       WHERE fp.user_id = $1
       ORDER BY f.created_at DESC`,
      [userId],
    );
    return result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      ownerId: r.owner_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      role: r.role,
    }));
  },

  /** Rename a folder. */
  async rename(folderId: string, name: string, userId: string): Promise<Folder> {
    const result = await query<{
      id: string;
      name: string;
      owner_id: string;
      created_at: string;
      updated_at: string;
    }>(
      `UPDATE folders SET name = $1 WHERE id = $2
       RETURNING id, name, owner_id, created_at, updated_at`,
      [name, folderId],
    );
    if (result.rows.length === 0) throw new Error('FOLDER_NOT_FOUND');

    await activityService.log(userId, 'folder_renamed', 'folder', folderId, { name });

    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  },

  /** Delete a folder (cascades to files and permissions). */
  async remove(folderId: string, userId: string): Promise<void> {
    await query('DELETE FROM folders WHERE id = $1', [folderId]);
    // Log activity AFTER successful delete to avoid phantom entries
    await activityService.log(userId, 'folder_deleted', 'folder', folderId, {});
  },

  /** Get a single folder by ID. */
  async getById(folderId: string): Promise<Folder | null> {
    const result = await query<{
      id: string;
      name: string;
      owner_id: string;
      created_at: string;
      updated_at: string;
    }>(
      'SELECT id, name, owner_id, created_at, updated_at FROM folders WHERE id = $1',
      [folderId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  },
};
