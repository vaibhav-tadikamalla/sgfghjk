/**
 * SessionTrackingService
 *
 * Pure in-memory service that tracks every live WebSocket connection as an
 * editing session.  One connection → one session, keyed by connectionId so
 * multiple tabs for the same user are tracked independently.
 *
 * No database I/O.  Data is lost when the process restarts, which is
 * intentional for this first iteration.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Data types
// ─────────────────────────────────────────────────────────────────────────────

export interface Session {
  /** WebSocket connection ID — the primary key. */
  connectionId: string;
  userId: string;
  /** Folder ID that the file belongs to (i.e. the "workspace"). */
  workspaceId: string;
  /** The file currently open in this connection. */
  currentFileId: string;
  /** Unix ms when the WS authenticated successfully. */
  sessionStartTime: number;
  /** Unix ms of the last edit or keep-alive activity. */
  lastActivityAt: number;
  /** Number of Yjs update messages applied by this connection. */
  totalEdits: number;
  /** All file IDs written to during this session (may be > 1 after file switches). */
  filesTouched: Set<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

import { getClusterTimeMs } from './clusterClock';

export class SessionTrackingService {
  private readonly sessions = new Map<string, Session>();

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Register a new session when a WebSocket connection authenticates.
   * Safe to call multiple times for the same connectionId (idempotent update).
   */
  createSession(
    connectionId: string,
    userId: string,
    workspaceId: string,
    fileId: string,
  ): void {
    const now = getClusterTimeMs();
    const existing = this.sessions.get(connectionId);
    if (existing) return; // already created — no-op

    this.sessions.set(connectionId, {
      connectionId,
      userId,
      workspaceId,
      currentFileId: fileId,
      sessionStartTime: now,
      lastActivityAt: now,
      totalEdits: 0,
      filesTouched: new Set([fileId]),
    });
  }

  /**
   * Remove a session on disconnect.  Safe to call when no session exists.
   */
  removeSession(connectionId: string): void {
    this.sessions.delete(connectionId);
  }

  // ── Mutation ───────────────────────────────────────────────────────────────

  /**
   * Increment the edit counter and refresh activity timestamp.
   * Called once per Yjs update message applied.
   * No-op if the session does not exist.
   */
  recordEdit(connectionId: string): void {
    const s = this.sessions.get(connectionId);
    if (!s) return;
    s.totalEdits += 1;
    s.lastActivityAt = getClusterTimeMs();
  }

  /**
   * Update the file the user is actively viewing/editing.
   * The previous file stays in `filesTouched` permanently.
   * No-op if the session does not exist or the file hasn't changed.
   */
  switchFile(connectionId: string, newFileId: string): void {
    const s = this.sessions.get(connectionId);
    if (!s || s.currentFileId === newFileId) return;
    s.currentFileId = newFileId;
    s.filesTouched.add(newFileId);
    s.lastActivityAt = getClusterTimeMs();
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /**
   * Return all active sessions for a specific workspace.
   * Returns a snapshot array — safe to iterate without holding a lock.
   */
  getSessionsForWorkspace(workspaceId: string): Session[] {
    const results: Session[] = [];
    for (const s of this.sessions.values()) {
      if (s.workspaceId === workspaceId) results.push(s);
    }
    return results;
  }

  /**
   * Return the session for a given connectionId, or undefined.
   */
  getSession(connectionId: string): Session | undefined {
    return this.sessions.get(connectionId);
  }

  /** Total number of live sessions across all workspaces. */
  get size(): number {
    return this.sessions.size;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default singleton — shared across the process
// ─────────────────────────────────────────────────────────────────────────────

export const sessionTracker = new SessionTrackingService();
