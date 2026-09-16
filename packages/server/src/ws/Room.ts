import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { WebSocket } from 'ws';
import { MSG_SYNC, MSG_AWARENESS, MSG_ACK, type ClientConnection } from './types';
import {
  roomsCreatedCounter,
  roomsDestroyedCounter,
  roomsByStateGauge,
  updatesAppliedCounter,
  updatesBroadcastCounter,
} from '../metrics/metrics';
import { crdtMergeLatency } from '../metrics/advancedMetrics';
import { byzantineRejectionsCounter } from '../metrics/advancedMetrics';
import { isBackpressured } from './backpressure';
import { getClusterTimeMs } from './clusterClock';

// ─── Room lifecycle ───────────────────────────────────────────────────────────

export type RoomState = 'loading' | 'active' | 'restoring' | 'idle' | 'destroying';

const VALID_TRANSITIONS = new Map<RoomState, ReadonlySet<RoomState>>([
  ['loading',    new Set<RoomState>(['active'])],
  ['active',     new Set<RoomState>(['restoring', 'idle'])],
  ['restoring',  new Set<RoomState>(['active'])],
  ['idle',       new Set<RoomState>(['active', 'destroying'])],
  ['destroying', new Set<RoomState>()],
]);

/**
 * Encapsulates all Yjs / awareness state for a single collaborative file.
 *
 * Design contract:
 *  - Y.Doc and Awareness are NEVER exposed outside this class.
 *  - All sync / awareness protocol handling happens through typed methods.
 *  - Broadcasting to other connections in the room is self-contained inside
 *    the sync/awareness handlers; callers pass the sender's connectionId so
 *    the originating connection is always excluded from the broadcast.
 *  - `doc.on('update')` is used only to mark the room dirty; the actual
 *    update-broadcast is handled inside `handleSyncMsg` (to match the
 *    original v1-protocol behaviour).
 *  - Persistence (dirty flag, save mutex) is coordinated through `runSave()`
 *    and `awaitSave()`; callers supply the actual write function.
 *  - Edit-counter tracking uses drain-based accumulation so the caller can
 *    batch DB writes on a fixed interval rather than per-keystroke.
 */
export class Room {
  // ── Yjs core ──────────────────────────────────────────────────────────────
  private readonly ydoc: Y.Doc;
  private readonly awareness: awarenessProtocol.Awareness;

  // ── Connected clients ─────────────────────────────────────────────────────
  private readonly connections: Map<string, ClientConnection> = new Map();

  // ── Lifecycle state ──────────────────────────────────────────────────────
  private _state: RoomState = 'loading';

  // ── Persistence state ──────────────────────────────────────────────────────
  private _dirty = false;
  private _saving = false;
  /** Promise-chain that serialises concurrent save calls. */
  private saveMutex: Promise<void> = Promise.resolve();

  // ── Memory tracking ────────────────────────────────────────────────────────
  private _estimatedSize = 0;
  private _lastCompactionMs = 0;

  // ── Debug counters (monotonic, never reset) ─────────────────────────────
  private _updatesApplied = 0;
  private _updatesBroadcast = 0;
  private _lastActivityMs = Date.now();

  // ── Pending edit accumulators (flushed on EDIT_FLUSH_INTERVAL) ────────────
  /** userId → number of doc-update messages received since last flush. */
  private readonly pendingEdits: Map<string, number> = new Map();
  /** userIds whose file.last_edited_by should be refreshed next flush. */
  private readonly pendingLastEdited: Set<string> = new Set();

  // ─────────────────────────────────────────────────────────────────────────

  constructor(persistedState?: Buffer | null) {
    this.ydoc = new Y.Doc();

    // Apply the persisted snapshot BEFORE wiring event listeners so that the
    // initial load does NOT mark the room dirty and does NOT trigger broadcasts.
    if (persistedState && persistedState.byteLength > 0) {
      Y.applyUpdate(this.ydoc, new Uint8Array(persistedState));
    }

    // Instrument: count creation and seed the initial state gauge bucket.
    roomsCreatedCounter.inc();
    roomsByStateGauge.inc({ state: this._state });

    this.awareness = new awarenessProtocol.Awareness(this.ydoc);

    // Mark dirty whenever the local doc changes due to an applied update.
    // Broadcasting is done explicitly inside handleSyncMsg (not here) so that
    // the sender is correctly excluded from the broadcast.
    this.ydoc.on('update', () => {
      this._dirty = true;
    });
  }

  // ── State machine ─────────────────────────────────────────────────────────

  private setState(next: RoomState): void {
    const allowed = VALID_TRANSITIONS.get(this._state);
    if (!allowed?.has(next)) {
      throw new Error(`Invalid Room state transition: ${this._state} → ${next}`);
    }
    const prev = this._state;  // capture before mutation
    this._state = next;
    roomsByStateGauge.dec({ state: prev });
    roomsByStateGauge.inc({ state: next });
  }

  /** Current lifecycle state of the room. */
  get state(): RoomState {
    return this._state;
  }

  /**
   * Transition from 'loading' to 'active'.
   * Must be called once after stored state has been applied (or confirmed absent).
   */
  activate(): void {
    this.setState('active');
  }

  // ── Connection management ─────────────────────────────────────────────────

  addConnection(conn: ClientConnection): void {
    // A new connection may arrive while the room is transiently idle (between
    // the last disconnect and the store deletion).  Transition back to active.
    if (this._state === 'idle') {
      this.setState('active');
    }
    this.connections.set(conn.connectionId, conn);
  }

  removeConnection(connId: string): void {
    this.connections.delete(connId);
  }

  getConnection(connId: string): ClientConnection | undefined {
    return this.connections.get(connId);
  }

  getConnections(): ReadonlyMap<string, ClientConnection> {
    return this.connections;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  // ── Debug introspection ───────────────────────────────────────────────────

  /**
   * Lightweight snapshot of room metrics for the /debug/rooms endpoint.
   * All reads are O(connections-in-room) — no locks, no CRDT access.
   */
  getDebugState(): {
    editors: number;
    viewers: number;
    connections: number;
    updatesApplied: number;
    updatesBroadcast: number;
    lastActivityTimestamp: number;
  } {
    let editors = 0;
    let viewers = 0;
    for (const [, conn] of this.connections) {
      if (conn.role === 'viewer') viewers++;
      else if (conn.role === 'editor' || conn.role === 'owner') editors++;
    }
    return {
      editors,
      viewers,
      connections: this.connections.size,
      updatesApplied: this._updatesApplied,
      updatesBroadcast: this._updatesBroadcast,
      lastActivityTimestamp: this._lastActivityMs,
    };
  }

  // ── Initial handshake helpers ─────────────────────────────────────────────

  /**
   * Build the MSG_SYNC + syncStep1 message to send to a freshly joined client.
   * The client will reply with syncStep2 containing any updates the server is
   * missing, and the server will also reply with a syncStep2 of its own later
   * when it receives the client's syncStep1.
   */
  buildSyncStep1Message(): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.ydoc);
    return encoding.toUint8Array(encoder);
  }

  /**
   * Build a MSG_AWARENESS frame containing the current awareness states of all
   * clients.  Returns null when the awareness map is empty.
   */
  buildAwarenessMessage(): Uint8Array | null {
    const states = this.awareness.getStates();
    if (states.size === 0) return null;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(states.keys())),
    );
    return encoding.toUint8Array(encoder);
  }

  // ── Protocol message handlers ─────────────────────────────────────────────

  /**
   * Handle an incoming MSG_SYNC binary frame from a client.
   *
   * - syncStep1 (type 0): returns a reply (syncStep2) to send back to the
   *   sender only.
   * - syncStep2 / update (type 1 / 2): applies the update with `Y.applyUpdate`
   *   (v1 protocol), then broadcasts the wrapped update to every OTHER
   *   connection in the room.  Returns `{ wasUpdate: true }` so the caller can
   *   bump the edit counter.
   *
   * @param msgData      Raw binary data including the leading MSG_SYNC varint.
   * @param canWrite     Whether the sender holds editor/owner permission.
   * @param senderConnId ConnectionId of the originating client (excluded from
   *                     the broadcast of updates).
   */
  handleSyncMsg(
    msgData: Uint8Array,
    canWrite: boolean,
    senderConnId: string,
    senderConn?: ClientConnection,
  ): { reply?: Uint8Array; permissionDenied?: boolean; wasUpdate?: boolean; rawUpdate?: Uint8Array } {
    try {
      const decoder = decoding.createDecoder(msgData);
      decoding.readVarUint(decoder); // consume MSG_SYNC prefix
      const syncType = decoding.readVarUint(decoder);

    // ── syncStep1 (type 0) ────────────────────────────────────────────────
      if (syncType === syncProtocol.messageYjsSyncStep1) {
        const stateVector = decoding.readVarUint8Array(decoder);
        if (senderConn?.backpressure) {
          senderConn.backpressure.lastKnownStateVector = stateVector;
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.writeSyncStep2(encoder, this.ydoc, stateVector);
        return { reply: encoding.toUint8Array(encoder) };
      }

    // ── syncStep2 (type 1) or update (type 2) ────────────────────────────
      if (
        syncType === syncProtocol.messageYjsSyncStep2 ||
        syncType === syncProtocol.messageYjsUpdate
      ) {
        if (!canWrite) return { permissionDenied: true };

        const update = decoding.readVarUint8Array(decoder);
        return { wasUpdate: true, rawUpdate: update };
      }

      return {};
    } catch (err) {
      byzantineRejectionsCounter.inc({ reason: 'protocol_invalid' });
      throw err;
    }
  }

  /**
   * Apply a client-originated CRDT update and broadcast to all peers except sender.
   *
   * This is intentionally separated from `handleSyncMsg` so the caller can
   * enforce WAL-first durability ordering:
   *   1) append WAL
   *   2) call this method
   */
  applyClientUpdate(update: Uint8Array, senderConnId: string): void {
    this._updatesApplied++;
    this._lastActivityMs = Date.now();
    updatesAppliedCounter.inc();
    const mergeT0 = performance.now();
    try {
      Y.applyUpdate(this.ydoc, update, null);
    } catch (err) {
      crdtMergeLatency.observe(performance.now() - mergeT0);
      byzantineRejectionsCounter.inc({ reason: 'apply_update_failed' });
      throw err; // re-throw so caller (websocket.ts) can log and close the connection
    }
    crdtMergeLatency.observe(performance.now() - mergeT0);

    try {
      const broadcastEncoder = encoding.createEncoder();
      encoding.writeVarUint(broadcastEncoder, MSG_SYNC);
      syncProtocol.writeUpdate(broadcastEncoder, update);
      this.broadcastBinary(encoding.toUint8Array(broadcastEncoder), senderConnId);
    } catch (err) {
      // Broadcast failure must never prevent the update from being applied.
      // Individual connection failures are handled inside broadcastBinary.
      // This catches encoding errors or iterator invalidation — extremely rare.
    }
  }

  /**
   * Handle an incoming MSG_AWARENESS binary frame from a client.
   *
   * Applies the update to the local awareness instance and broadcasts it to
   * every OTHER connection in the room.  Also extracts and stores the sender's
   * Yjs awareness clientID on first call so it can be removed on disconnect.
   *
   * @param msgData Raw binary data including the leading MSG_AWARENESS varint.
   * @param conn    The connection that sent the update.
   */
  handleAwarenessMsg(msgData: Uint8Array, conn: ClientConnection): void {
    let update: Uint8Array;
    try {
      const decoder = decoding.createDecoder(msgData);
      decoding.readVarUint(decoder); // consume MSG_AWARENESS prefix
      update = decoding.readVarUint8Array(decoder);
    } catch (err) {
      byzantineRejectionsCounter.inc({ reason: 'protocol_invalid' });
      throw err;
    }

    // Capture the sender's awareness clientID (the first entry in the update)
    // so we can clean it up when the client disconnects.
    if (conn.awarenessClientId === undefined) {
      try {
        const pd = decoding.createDecoder(update);
        const numClients = decoding.readVarUint(pd);
        if (numClients > 0) {
          conn.awarenessClientId = decoding.readVarUint(pd);
        }
      } catch {
        // Malformed awareness frame — ignore, clientId tracking just won't work
      }
    }

    try {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, conn.ws);
    } catch (err) {
      byzantineRejectionsCounter.inc({ reason: 'protocol_invalid' });
      throw err;
    }

    // Forward the raw update (re-wrapped) to every other connection
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, update);
    this.broadcastBinary(encoding.toUint8Array(encoder), conn.connectionId);
  }

  /**
   * Remove the awareness states for the given Yjs client IDs.
   * This prevents ghost cursors from lingering after a client disconnects.
   */
  removeAwarenessStates(clientIds: number[]): void {
    if (clientIds.length === 0) return;
    awarenessProtocol.removeAwarenessStates(this.awareness, clientIds, null);
  }

  // ── Edit tracking ─────────────────────────────────────────────────────────

  /**
   * Increment the pending edit counter for a user.
   * Call once per update message received from an authenticated editor.
   */
  trackEdit(userId: string): void {
    const current = this.pendingEdits.get(userId) ?? 0;
    this.pendingEdits.set(userId, current + 1);
    this.pendingLastEdited.add(userId);
  }

  /**
   * Drain the pending edit counters for a single user and return them.
   * Returns null when the user has no pending edits.
   * Used on disconnect to flush the leaving user's counts before the room
   * might be destroyed.
   */
  drainUserPendingEdits(userId: string): { count: number; updateLastEdited: boolean } | null {
    const count = this.pendingEdits.get(userId);
    if (count === undefined) return null;
    const updateLastEdited = this.pendingLastEdited.has(userId);
    this.pendingEdits.delete(userId);
    this.pendingLastEdited.delete(userId);
    return { count, updateLastEdited };
  }

  /**
   * Drain the pending edit counters for ALL users and return them.
   * The internal maps are cleared atomically after this call.
   * Used by the periodic flush interval to batch-write to the database.
   *
   * Returns Map< userId → { count, updateLastEdited } >.
   */
  drainPendingEdits(): Map<string, { count: number; updateLastEdited: boolean }> {
    const result = new Map<string, { count: number; updateLastEdited: boolean }>();
    for (const [userId, count] of this.pendingEdits) {
      result.set(userId, {
        count,
        updateLastEdited: this.pendingLastEdited.has(userId),
      });
    }
    this.pendingEdits.clear();
    this.pendingLastEdited.clear();
    return result;
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  get dirty(): boolean {
    return this._dirty;
  }

  get saving(): boolean {
    return this._saving;
  }

  /**
   * Encode the current document state as a v1 Buffer for storage.
   */
  encodeStateAsUpdate(): Buffer {
    return Buffer.from(Y.encodeStateAsUpdate(this.ydoc));
  }

  /**
   * Encode the current state vector for reconciliation.
   */
  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.ydoc);
  }

  /**
   * Get the raw Y.Doc reference for cross-node reconciliation.
   * ONLY for use by redisReconciliation — never expose externally.
   */
  getDocForReconciliation(): Y.Doc {
    return this.ydoc;
  }

  /**
   * Apply a CRDT update received from a remote node (via Redis Streams).
   *
   * Applies the raw Yjs update to the local Y.Doc and broadcasts the
   * resulting sync message to all locally-connected clients.
   *
   * Unlike handleSyncMsg, this bypasses permission checks (the update was
   * already validated on the originating node) and does not re-publish to
   * Redis (loop prevention is handled by the stream consumer).
   */
  applyRemoteUpdate(update: Uint8Array): void {
    this._updatesApplied++;
    this._lastActivityMs = Date.now();
    updatesAppliedCounter.inc();
    const mergeT0 = performance.now();
    try {
      Y.applyUpdate(this.ydoc, update, 'remote-stream');
    } catch (err) {
      crdtMergeLatency.observe(performance.now() - mergeT0);
      byzantineRejectionsCounter.inc({ reason: 'remote_apply_failed' });
      throw err;
    }
    crdtMergeLatency.observe(performance.now() - mergeT0);

    // Build sync update message and broadcast to all local clients.
    // Broadcast failures are isolated per-connection inside broadcastBinary.
    try {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcastBinary(encoding.toUint8Array(encoder));
    } catch {
      // Encoding error — extremely unlikely but must never crash the stream consumer.
    }
  }

  /** Estimated byte size of the Y.Doc (cached, updated after compaction). */
  get estimatedSize(): number {
    return this._estimatedSize;
  }

  /** Timestamp of last compaction (0 if never compacted). */
  get lastCompactionMs(): number {
    return this._lastCompactionMs;
  }

  /**
   * Recalculate and cache the estimated Y.Doc size.
   * Call periodically (e.g. during compaction sweep) — NOT on every update.
   */
  refreshEstimatedSize(): number {
    try {
      this._estimatedSize = Y.encodeStateAsUpdate(this.ydoc).byteLength;
    } catch {
      this._estimatedSize = 0;
    }
    return this._estimatedSize;
  }

  /**
   * Replace the internal Y.Doc with a compacted state.
   *
   * This is the atomic swap step of CRDT compaction:
   *   1. Apply the compacted state to a new Y.Doc.
   *   2. Transfer all awareness states.
   *   3. Re-wire event listeners.
   *   4. Destroy the old Y.Doc.
   *
   * MUST be called while no save is in progress (check `saving` first).
   */
  applyCompactedState(compactedState: Buffer): void {
    // Save current awareness states
    const awarenessStates = this.awareness.getStates();
    const clientIds = Array.from(awarenessStates.keys());

    // Create fresh doc with compacted state
    const newDoc = new Y.Doc();
    Y.applyUpdate(newDoc, new Uint8Array(compactedState));

    // Wire the dirty listener on the new doc
    newDoc.on('update', () => { this._dirty = true; });

    // Destroy the old doc
    const oldDoc = this.ydoc;
    oldDoc.destroy();

    // Swap the doc reference (using Object.defineProperty to bypass readonly)
    (this as any).ydoc = newDoc;

    // Create new awareness on the new doc
    const oldAwareness = this.awareness;
    const newAwareness = new awarenessProtocol.Awareness(newDoc);
    (this as any).awareness = newAwareness;

    // Restore awareness states
    // Note: awareness states from disconnected clients will naturally expire
    oldAwareness.destroy();

    this._lastCompactionMs = getClusterTimeMs();
    this.refreshEstimatedSize();
  }

  /**
   * Schedule and await a serialised save operation.
   *
   * Multiple callers may call runSave() concurrently; they are chained via
   * `saveMutex` so each save runs after the previous one completes.  Each
   * link re-checks `dirty` so redundant saves are skipped.
   *
   * @param saveFn  Async function that writes the encoded state to storage.
   *                Receives the Buffer returned by `encodeStateAsUpdate()`.
   */
  async runSave(saveFn: (state: Buffer) => Promise<void>): Promise<void> {
    if (!this._dirty) return;
    this.saveMutex = this.saveMutex.then(async () => {
      if (!this._dirty) return;
      this._saving = true;
      try {
        const state = this.encodeStateAsUpdate();
        await saveFn(state);
        this._dirty = false;
      } finally {
        this._saving = false;
      }
    });
    await this.saveMutex;
  }

  /**
   * Await completion of any in-progress save (useful during graceful shutdown).
   */
  async awaitSave(): Promise<void> {
    await this.saveMutex;
  }

  // ── Broadcasting ───────────────────────────────────────────────────────────

  /**
   * Send a binary frame to every open connection in the room,
   * optionally excluding one connection (typically the sender).
   *
   * Backpressure-aware: connections whose bufferedAmount exceeds the
   * high-water mark are skipped.  They will receive a catch-up diff
   * when their buffer drains.
   */
  broadcastBinary(data: Uint8Array, excludeConnId?: string): void {
    this._updatesBroadcast++;
    updatesBroadcastCounter.inc();
    for (const [id, conn] of this.connections) {
      if (id === excludeConnId) continue;
      if (conn.ws.readyState !== WebSocket.OPEN) continue;

      // Check backpressure before sending
      if (conn.backpressure && isBackpressured(conn.ws, conn.backpressure, id)) {
        continue; // Skip this client — they are buffered
      }
      if (conn.backpressure?.needsCatchup) {
        try {
          this.sendCatchupDiff(conn);
        } catch {
          /* sendCatchupDiff handles its own errors; guard against unexpected throws */
        }
      }
      try {
        conn.ws.send(data);
      } catch {
        /* Connection will close on its own — handled in handleDisconnect */
      }
    }
  }

  /**
   * Send a catch-up diff to a client that was previously paused by backpressure.
   */
  private sendCatchupDiff(conn: ClientConnection): void {
    if (!conn.backpressure || !conn.backpressure.needsCatchup) return;
    if (conn.ws.readyState !== WebSocket.OPEN) {
      conn.backpressure.needsCatchup = false;
      return;
    }

    try {
      const sv = conn.backpressure.lastKnownStateVector;
      const diff = sv
        ? Y.encodeStateAsUpdate(this.ydoc, sv)
        : Y.encodeStateAsUpdate(this.ydoc);

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, diff);
      conn.ws.send(encoding.toUint8Array(encoder));

      conn.backpressure.lastKnownStateVector = Y.encodeStateVector(this.ydoc);
      conn.backpressure.needsCatchup = false;
      conn.backpressure.skippedUpdates = 0;
    } catch {
      conn.backpressure.needsCatchup = false;
      try { conn.ws.close(1008, 'Invalid protocol message'); } catch { /* ignore */ }
    }
  }

  /**
   * Send a JSON-serialisable payload to every open connection in the room,
   * optionally excluding one.
   */
  broadcastJson(payload: Record<string, unknown>, excludeConnId?: string): void {
    const msg = JSON.stringify(payload);
    for (const [id, conn] of this.connections) {
      if (id === excludeConnId) continue;
      if (conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(msg);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Mark the room as idle (no remaining connections).
   * Must be called before destroy() to follow the active → idle → destroying
   * state-machine path.
   */
  markIdle(): void {
    this.setState('idle');
  }

  /**
   * Tear down the Yjs document and awareness instance.
   * Requires the room to be in 'idle' state; call markIdle() first.
   * Always call this after removing a room from the store so that internal
   * Yjs timers are cleaned up and memory is released.
   */
  destroy(): void {
    this.setState('destroying');
    roomsDestroyedCounter.inc();
    this.awareness.destroy();
    this.ydoc.destroy();
  }
}
