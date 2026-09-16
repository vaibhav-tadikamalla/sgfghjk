/**
 * DashboardSubscriptionManager
 *
 * Manages real-time WebSocket subscriptions for workspace dashboard updates.
 * Lives entirely in memory — no DB writes, no Redis, no external dependencies.
 *
 * Architecture:
 *   subscribe(conn, workspaceId)            — add a connection to a workspace's subscriber set
 *   unsubscribe(conn)                       — O(1) removal on disconnect or re-subscription
 *   notifyWorkspaceUpdate(workspaceId, immediate?) — trigger a dashboard snapshot broadcast
 *
 * Debounce strategy:
 *   - Edit events (high frequency) are debounced: at most 1 broadcast per workspace
 *     every DEBOUNCE_MS milliseconds, regardless of how many triggers arrive.
 *   - Join / leave events bypass the timer and push a snapshot immediately (the
 *     caller sets `immediate = true` for these cases).
 *
 * Separation of concerns:
 *   - This class has zero awareness of Y.Doc, Room, or Yjs sync logic.
 *   - It receives `ClientConnection` objects only to hold their `.ws` socket and
 *     `.connectionId` key — it never inspects Yjs state.
 */

import { WebSocket } from 'ws';
import { getLogger } from '../utils/logger';
import type { ClientConnection } from './types';
import { sessionTracker } from './SessionTrackingService';
import {
  WorkspaceDashboardService,
  type WorkspaceDashboard,
} from '../services/workspaceDashboardService';

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum gap (ms) between successive broadcasts for the same workspace for edit events. */
const DEBOUNCE_MS = 2_000;

// ─────────────────────────────────────────────────────────────────────────────
// Manager
// ─────────────────────────────────────────────────────────────────────────────

export class DashboardSubscriptionManager {
  /** workspaceId → subscriber connections */
  private readonly subscriptions = new Map<string, Set<ClientConnection>>();
  /** connectionId → workspaceId — reverse index for O(1) lookup on disconnect */
  private readonly connToWorkspace = new Map<string, string>();
  /** Per-workspace debounce timers for edit-triggered update coalescing */
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly dashboardService: WorkspaceDashboardService) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Subscribe `conn` to live dashboard updates for `workspaceId`.
   *
   * If the connection was already subscribed to a different workspace its
   * previous subscription is atomically replaced — one connection, one workspace.
   */
  subscribe(conn: ClientConnection, workspaceId: string): void {
    // Drop any previous subscription for this connection first
    this.unsubscribe(conn);

    let subs = this.subscriptions.get(workspaceId);
    if (!subs) {
      subs = new Set();
      this.subscriptions.set(workspaceId, subs);
    }
    subs.add(conn);
    this.connToWorkspace.set(conn.connectionId, workspaceId);
  }

  /**
   * Remove `conn` from its subscribed workspace.
   * Safe to call when the connection was never subscribed (no-op).
   */
  unsubscribe(conn: ClientConnection): void {
    const workspaceId = this.connToWorkspace.get(conn.connectionId);
    if (!workspaceId) return;

    this.connToWorkspace.delete(conn.connectionId);
    const subs = this.subscriptions.get(workspaceId);
    if (subs) {
      subs.delete(conn);
      if (subs.size === 0) {
        this.subscriptions.delete(workspaceId);
        // No subscribers remain — cancel any pending timer to avoid a wasted broadcast
        this.clearTimer(workspaceId);
      }
    }
  }

  /**
   * Queue a dashboard snapshot broadcast for `workspaceId`.
   *
   * @param workspaceId The workspace whose subscribers should be notified.
   * @param immediate   When true (join / leave events), cancels any pending
   *                    debounce and broadcasts right away.  When false (default,
   *                    used by edit events), re-arms the debounce window so
   *                    bursts of edits collapse into a single broadcast.
   */
  notifyWorkspaceUpdate(workspaceId: string, immediate = false): void {
    // Fast path — nothing to do if no one is listening
    if (!this.subscriptions.has(workspaceId)) return;

    if (immediate) {
      this.clearTimer(workspaceId);
      this.broadcastSnapshot(workspaceId);
      return;
    }

    // Debounced path: re-arm the timer (cancels any existing one)
    this.clearTimer(workspaceId);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(workspaceId);
      this.broadcastSnapshot(workspaceId);
    }, DEBOUNCE_MS);
    this.debounceTimers.set(workspaceId, timer);
  }

  /**
   * Cancel all pending timers and clear all state.
   * Must be called during graceful shutdown to prevent timer leaks.
   */
  destroy(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.subscriptions.clear();
    this.connToWorkspace.clear();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private clearTimer(workspaceId: string): void {
    const t = this.debounceTimers.get(workspaceId);
    if (t !== undefined) {
      clearTimeout(t);
      this.debounceTimers.delete(workspaceId);
    }
  }

  /**
   * Compute the current dashboard snapshot and push it to every open subscriber
   * in the workspace.  Dead sockets (readyState !== OPEN) are skipped; the
   * disconnect handler will call `unsubscribe()` to clean them up.
   */
  private broadcastSnapshot(workspaceId: string): void {
    const subs = this.subscriptions.get(workspaceId);
    if (!subs || subs.size === 0) return;

    let snapshot: WorkspaceDashboard;
    try {
      snapshot = this.dashboardService.getDashboard(workspaceId);
    } catch (err) {
      getLogger().error(
        { err, workspaceId },
        'DashboardSubscriptionManager: failed to compute snapshot',
      );
      return;
    }

    const message = JSON.stringify({ type: 'dashboard_update', payload: snapshot });

    for (const conn of subs) {
      if (conn.ws.readyState !== WebSocket.OPEN) continue;
      try {
        conn.ws.send(message);
      } catch {
        /* ignore — the disconnect handler will call unsubscribe() */
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default singleton — shared across the process
//
// Constructed with the shared sessionTracker so the same in-memory session state
// that feeds the REST dashboard endpoint also powers live WebSocket broadcasts.
// ─────────────────────────────────────────────────────────────────────────────

export const dashboardSubscriptionManager = new DashboardSubscriptionManager(
  new WorkspaceDashboardService(sessionTracker),
);
