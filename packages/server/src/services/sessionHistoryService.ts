/**
 * SessionHistoryService
 *
 * Persists completed WebSocket collaboration sessions to the
 * `session_history` table.  One row per connection, written on
 * disconnect after the in-memory session is captured but before
 * it is removed from SessionTrackingService.
 *
 * Design constraints (from spec):
 *   - No fatal errors — every method catches internally and logs.
 *   - No circular deps — imports only from db/pool and utils/logger.
 *   - Not coupled to the WebSocket layer; receives plain data objects.
 */

import { query } from '../db/pool';
import { getLogger } from '../utils/logger';
import type { WorkspaceRole } from '../ws/types';

// ─────────────────────────────────────────────────────────────────────────────
// Input shape
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionRecord {
  userId: string;
  workspaceId: string;
  /** Unix ms — matches Session.sessionStartTime */
  sessionStartMs: number;
  /** Unix ms — captured at the moment of disconnect */
  sessionEndMs: number;
  totalEdits: number;
  /** Array of file IDs touched during the session */
  filesTouched: string[];
  role: WorkspaceRole;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export const sessionHistoryService = {
  /**
   * Persist one completed session.
   *
   * Failures are logged but never rethrown — the caller (handleDisconnect)
   * must continue its cleanup regardless of DB availability.
   */
  async recordSession(data: SessionRecord): Promise<void> {
    const durationSeconds = Math.max(
      0,
      Math.round((data.sessionEndMs - data.sessionStartMs) / 1_000),
    );

    try {
      await query(
        `INSERT INTO session_history
           (user_id, workspace_id, session_start, session_end,
            duration_seconds, total_edits, files_touched, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          data.userId,
          data.workspaceId,
          new Date(data.sessionStartMs).toISOString(),
          new Date(data.sessionEndMs).toISOString(),
          durationSeconds,
          data.totalEdits,
          JSON.stringify(data.filesTouched),
          data.role,
        ],
      );
    } catch (err) {
      // Non-fatal: log and continue — the caller must not block on this
      getLogger().error(
        { err, userId: data.userId, workspaceId: data.workspaceId },
        'sessionHistoryService: failed to persist session record',
      );
    }
  },
};
