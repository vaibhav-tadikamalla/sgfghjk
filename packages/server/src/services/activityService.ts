import { query } from '../db/pool';
import type pg from 'pg';

export interface ActivityEntry {
  id: string;
  userId: string | null;
  displayName: string | null;
  actionType: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export const activityService = {
  /** Log an activity event. */
  async log(
    userId: string,
    actionType: string,
    entityType: 'folder' | 'file',
    entityId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await query(
      `INSERT INTO activity_logs (user_id, action_type, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, actionType, entityType, entityId, JSON.stringify(metadata)],
    );
  },

  /** Log an activity event within a transaction. */
  async logWithClient(
    client: pg.PoolClient,
    userId: string,
    actionType: string,
    entityType: 'folder' | 'file',
    entityId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await client.query(
      `INSERT INTO activity_logs (user_id, action_type, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, actionType, entityType, entityId, JSON.stringify(metadata)],
    );
  },

  /** Get activity for a specific entity. */
  async listForEntity(
    entityType: 'folder' | 'file',
    entityId: string,
    limit = 50,
  ): Promise<ActivityEntry[]> {
    const result = await query<{
      id: string;
      user_id: string | null;
      display_name: string | null;
      action_type: string;
      entity_type: string;
      entity_id: string;
      metadata: Record<string, unknown>;
      created_at: string;
    }>(
      `SELECT al.id, al.user_id, u.display_name, al.action_type,
              al.entity_type, al.entity_id, al.metadata, al.created_at
       FROM activity_logs al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE al.entity_type = $1 AND al.entity_id = $2
       ORDER BY al.created_at DESC
       LIMIT $3`,
      [entityType, entityId, limit],
    );
    return result.rows.map(mapActivityRow);
  },

  /** Get activity for a folder and all its files. */
  async listForFolder(folderId: string, limit = 100): Promise<ActivityEntry[]> {
    const result = await query<{
      id: string;
      user_id: string | null;
      display_name: string | null;
      action_type: string;
      entity_type: string;
      entity_id: string;
      metadata: Record<string, unknown>;
      created_at: string;
    }>(
      `SELECT al.id, al.user_id, u.display_name, al.action_type,
              al.entity_type, al.entity_id, al.metadata, al.created_at
       FROM activity_logs al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE (al.entity_type = 'folder' AND al.entity_id = $1)
          OR (al.entity_type = 'file' AND al.entity_id IN (
              SELECT id FROM files WHERE folder_id = $1
          ))
       ORDER BY al.created_at DESC
       LIMIT $2`,
      [folderId, limit],
    );
    return result.rows.map(mapActivityRow);
  },
};

function mapActivityRow(row: {
  id: string;
  user_id: string | null;
  display_name: string | null;
  action_type: string;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
}): ActivityEntry {
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    actionType: row.action_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}
