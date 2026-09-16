import { query } from '../db/pool';

export interface EditSession {
  id: string;
  fileId: string;
  userId: string;
  startedAt: string;
  endedAt: string | null;
  editsCount: number;
}

export interface Contributor {
  userId: string;
  displayName: string;
  email: string;
  totalEdits: number;
  lastEditedAt: string;
}

export interface PasteEventsPerSession {
  sessionId: string;
  fileId: string;
  fileName: string;
  userId: string;
  displayName: string;
  email: string;
  pasteEventsCount: number;
  editsCount: number;
  startedAt: string;
  endedAt: string | null;
}

export interface AvgEditsPerMinuteByUserFile {
  fileId: string;
  fileName: string;
  userId: string;
  displayName: string;
  email: string;
  totalEdits: number;
  totalMinutes: number;
  avgEditsPerMinute: number;
  sessions: number;
}

export const editTrackingService = {
  /** Start an edit session for a user on a file. Reuses an active session if one exists. */
  async startSession(fileId: string, userId: string): Promise<string> {
    // Check for existing active session
    const existing = await query<{ id: string }>(
      `SELECT id FROM edit_sessions
       WHERE file_id = $1 AND user_id = $2 AND ended_at IS NULL`,
      [fileId, userId],
    );
    if (existing.rows.length > 0) return existing.rows[0].id;

    const result = await query<{ id: string }>(
      `INSERT INTO edit_sessions (file_id, user_id)
       VALUES ($1, $2) RETURNING id`,
      [fileId, userId],
    );
    return result.rows[0].id;
  },

  /** End an edit session. */
  async endSession(fileId: string, userId: string): Promise<void> {
    await query(
      `UPDATE edit_sessions SET ended_at = NOW()
       WHERE file_id = $1 AND user_id = $2 AND ended_at IS NULL`,
      [fileId, userId],
    );
  },

  /** Increment edits count for the active session. */
  async incrementEdits(fileId: string, userId: string): Promise<void> {
    await query(
      `UPDATE edit_sessions SET edits_count = edits_count + 1
       WHERE file_id = $1 AND user_id = $2 AND ended_at IS NULL`,
      [fileId, userId],
    );
  },

  /** Increment edits count by N (batched flush from in-memory accumulator). */
  async incrementEditsBy(fileId: string, userId: string, count: number): Promise<void> {
    await query(
      `UPDATE edit_sessions SET edits_count = edits_count + $3
       WHERE file_id = $1 AND user_id = $2 AND ended_at IS NULL`,
      [fileId, userId, count],
    );
  },

  /** Increment paste-events count by N for an active edit session. */
  async incrementPasteEventsBy(fileId: string, userId: string, count: number): Promise<void> {
    await query(
      `UPDATE edit_sessions SET paste_events_count = paste_events_count + $3
       WHERE file_id = $1 AND user_id = $2 AND ended_at IS NULL`,
      [fileId, userId, count],
    );
  },

  /** Get all contributors for a file with aggregated stats. */
  async getContributors(fileId: string): Promise<Contributor[]> {
    const result = await query<{
      user_id: string;
      display_name: string;
      email: string;
      total_edits: string;
      last_edited_at: string;
    }>(
      `SELECT es.user_id, u.display_name, u.email,
              SUM(es.edits_count)::text AS total_edits,
              MAX(COALESCE(es.ended_at, es.started_at)) AS last_edited_at
       FROM edit_sessions es
       JOIN users u ON u.id = es.user_id
       WHERE es.file_id = $1
       GROUP BY es.user_id, u.display_name, u.email
       ORDER BY last_edited_at DESC`,
      [fileId],
    );
    return result.rows.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      email: r.email,
      totalEdits: parseInt(r.total_edits, 10),
      lastEditedAt: r.last_edited_at,
    }));
  },

  /** Get active sessions for a file (currently connected editors). */
  async getActiveSessions(fileId: string): Promise<Array<{ userId: string; displayName: string; startedAt: string }>> {
    const result = await query<{
      user_id: string;
      display_name: string;
      started_at: string;
    }>(
      `SELECT es.user_id, u.display_name, es.started_at
       FROM edit_sessions es
       JOIN users u ON u.id = es.user_id
       WHERE es.file_id = $1 AND es.ended_at IS NULL`,
      [fileId],
    );
    return result.rows.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      startedAt: r.started_at,
    }));
  },

  /**
   * Reviewer visibility metrics for the admin dashboard.
   * - pasteEventsPerSession: sessions with observed paste events
   * - avgEditsPerMinuteByUserFile: aggregated edit velocity by user+file
   */
  async getReviewerVisibilityMetrics(limit = 25): Promise<{
    pasteEventsPerSession: PasteEventsPerSession[];
    avgEditsPerMinuteByUserFile: AvgEditsPerMinuteByUserFile[];
  }> {
    const safeLimit = Math.max(1, Math.min(limit, 100));

    const pasteResult = await query<{
      id: string;
      file_id: string;
      file_name: string;
      user_id: string;
      display_name: string;
      email: string;
      paste_events_count: number;
      edits_count: number;
      started_at: string;
      ended_at: string | null;
    }>(
      `SELECT es.id, es.file_id, f.name AS file_name,
              es.user_id, u.display_name, u.email,
              es.paste_events_count, es.edits_count,
              es.started_at, es.ended_at
       FROM edit_sessions es
       JOIN users u ON u.id = es.user_id
       JOIN files f ON f.id = es.file_id
       WHERE es.paste_events_count > 0
       ORDER BY COALESCE(es.ended_at, es.started_at) DESC
       LIMIT $1`,
      [safeLimit],
    );

    const avgResult = await query<{
      file_id: string;
      file_name: string;
      user_id: string;
      display_name: string;
      email: string;
      total_edits: string;
      total_minutes: string;
      avg_edits_per_minute: string;
      sessions: string;
    }>(
      `SELECT es.file_id, f.name AS file_name,
              es.user_id, u.display_name, u.email,
              SUM(es.edits_count)::text AS total_edits,
              SUM(GREATEST(EXTRACT(EPOCH FROM (COALESCE(es.ended_at, NOW()) - es.started_at)) / 60.0, 1.0 / 60.0))::text AS total_minutes,
              (SUM(es.edits_count) / SUM(GREATEST(EXTRACT(EPOCH FROM (COALESCE(es.ended_at, NOW()) - es.started_at)) / 60.0, 1.0 / 60.0)))::text AS avg_edits_per_minute,
              COUNT(*)::text AS sessions
       FROM edit_sessions es
       JOIN users u ON u.id = es.user_id
       JOIN files f ON f.id = es.file_id
       GROUP BY es.file_id, f.name, es.user_id, u.display_name, u.email
       HAVING SUM(es.edits_count) > 0
       ORDER BY (SUM(es.edits_count) / SUM(GREATEST(EXTRACT(EPOCH FROM (COALESCE(es.ended_at, NOW()) - es.started_at)) / 60.0, 1.0 / 60.0))) DESC
       LIMIT $1`,
      [safeLimit],
    );

    return {
      pasteEventsPerSession: pasteResult.rows.map((r) => ({
        sessionId: r.id,
        fileId: r.file_id,
        fileName: r.file_name,
        userId: r.user_id,
        displayName: r.display_name,
        email: r.email,
        pasteEventsCount: r.paste_events_count,
        editsCount: r.edits_count,
        startedAt: r.started_at,
        endedAt: r.ended_at,
      })),
      avgEditsPerMinuteByUserFile: avgResult.rows.map((r) => ({
        fileId: r.file_id,
        fileName: r.file_name,
        userId: r.user_id,
        displayName: r.display_name,
        email: r.email,
        totalEdits: parseInt(r.total_edits, 10),
        totalMinutes: Number(r.total_minutes),
        avgEditsPerMinute: Number(r.avg_edits_per_minute),
        sessions: parseInt(r.sessions, 10),
      })),
    };
  },
};
