import type { SessionTrackingService } from '../ws/SessionTrackingService';

// ─────────────────────────────────────────────────────────────────────────────
// Response shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface ActiveUserEntry {
  userId: string;
  currentFileId: string;
  /** Duration in ms since the WS connection authenticated. */
  sessionDuration: number;
  /** Unix ms of the last edit activity. */
  lastActivityAt: number;
  totalEdits: number;
}

export interface ActiveFileEntry {
  fileId: string;
  activeUsersCount: number;
}

export interface WorkspaceDashboard {
  workspaceId: string;
  activeUsers: ActiveUserEntry[];
  activeFiles: ActiveFileEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export class WorkspaceDashboardService {
  constructor(private readonly tracker: SessionTrackingService) {}

  /**
   * Build a real-time snapshot of who is active in a workspace.
   *
   * `activeUsers` is de-duplicated by userId.  When a user has multiple
   * connections open (multiple tabs), the entry with the most recent
   * `lastActivityAt` timestamp is used.
   *
   * `activeFiles` counts unique users per file (not connections).
   */
  getDashboard(workspaceId: string): WorkspaceDashboard {
    const sessions = this.tracker.getSessionsForWorkspace(workspaceId);
    const now = Date.now();

    // ── De-duplicate by userId: keep the most recently active session ────
    const byUser = new Map<string, (typeof sessions)[number]>();
    for (const s of sessions) {
      const existing = byUser.get(s.userId);
      if (!existing || s.lastActivityAt > existing.lastActivityAt) {
        byUser.set(s.userId, s);
      }
    }

    const activeUsers: ActiveUserEntry[] = Array.from(byUser.values()).map((s) => ({
      userId: s.userId,
      currentFileId: s.currentFileId,
      sessionDuration: now - s.sessionStartTime,
      lastActivityAt: s.lastActivityAt,
      totalEdits: s.totalEdits,
    }));

    // ── Count unique users per file (using de-duplicated user list) ──────
    const fileUserCounts = new Map<string, Set<string>>();
    for (const s of byUser.values()) {
      const set = fileUserCounts.get(s.currentFileId) ?? new Set();
      set.add(s.userId);
      fileUserCounts.set(s.currentFileId, set);
    }

    const activeFiles: ActiveFileEntry[] = Array.from(fileUserCounts.entries()).map(
      ([fileId, users]) => ({ fileId, activeUsersCount: users.size }),
    );

    return { workspaceId, activeUsers, activeFiles };
  }
}
