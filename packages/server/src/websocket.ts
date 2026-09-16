/**
 * websocket.ts
 *
 * Collaboration WebSocket server.
 *
 * CollaborationServer wires together three purpose-built layer objects:
 *   - InMemoryRoomStore             (room lifecycle + concurrent-create coalescing)
 *   - DefaultRoomPersistenceService (all database operations for rooms)
 *   - WorkspacePermissionGateway    (permission checks)
 *
 * The class itself contains NO Y.Doc / Yjs imports, NO direct DB calls
 * for room data, and NO raw Map<string, Room> field.  Those concerns live in
 * the ./ws/ sub-modules.
 *
 * Public interface is backwards-compatible with the original implementation
 * so that route handlers (folders.ts, permissions.ts) and index.ts require
 * no changes.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, RawData } from 'ws';

import { getLogger } from './utils/logger';
import { verifyAccessToken } from './auth/jwt';
import { query } from './db/pool';
import { loadSnapshot } from './persistence/snapshotStore';
import { enqueueSnapshot, drainSnapshotQueue } from './persistence/snapshotQueue';
import { appendUpdate } from './persistence/updateLog';
import {
  compactDoc,
  isCompactionEligible,
  recordCompaction,
  clearCompactionState,
  logCompactionEvent,
  COMPACTION_SWEEP_INTERVAL_MS,
} from './persistence/compactionService';
import { autoCapture, clearCaptureState } from './services/versionService';
import {
  activeRoomsGauge,
  activeSessionsGauge,
  wsMessagesSentCounter,
  wsMessagesReceivedCounter,
  connectionsOpenedCounter,
  connectionsClosedCounter,
} from './metrics/metrics';
import {
  walAppendLatency,
  clientAckLatency,
  byzantineRejectionsCounter,
} from './metrics/advancedMetrics';

import { Room } from './ws/Room';
import { InMemoryRoomStore, type RoomStore } from './ws/RoomStore';
import { RedisRoomStore, type ForwardedWriteRequest } from './ws/RedisRoomStore';
import { EdgeMirrorManager } from './ws/EdgeMirrorManager';
import {
  DefaultRoomPersistenceService,
  type RoomPersistenceService,
} from './ws/RoomPersistenceService';
import { WorkspacePermissionGateway, type PermissionGateway } from './ws/PermissionGateway';
import {
  SessionTrackingService,
  sessionTracker as defaultSessionTracker,
} from './ws/SessionTrackingService';
import {
  DashboardSubscriptionManager,
  dashboardSubscriptionManager as defaultSubscriptionManager,
} from './ws/DashboardSubscriptionManager';
import { sessionHistoryService } from './services/sessionHistoryService';
import {
  getRawDataByteLength,
  isEditThrottled,
  MAX_MESSAGE_BYTES,
  MAX_SESSIONS_PER_USER,
  MAX_JSON_CONTROL_BYTES,
  KNOWN_JSON_CONTROL_TYPES,
  UUID_RE,
  type EditBurstState,
} from './ws/ConnectionGuards';
import {
  MSG_SYNC,
  MSG_AWARENESS,
  MSG_ACK,
  PING_INTERVAL_MS,
  AUTH_TIMEOUT_MS,
  EDIT_FLUSH_INTERVAL_MS,
  type ClientConnection,
} from './ws/types';
import { createBackpressureState } from './ws/backpressure';
import { validateCrdtPayload } from './ws/byzantineGuard';
import {
  RoomLruIndex,
  computeEvictionPlan,
  MAX_ROOMS_IN_MEMORY,
  IDLE_EVICTION_TIMEOUT_MS,
  EVICTION_SWEEP_INTERVAL_MS,
} from './ws/roomEvictor';
import { roomEvictionCounter, roomEvictionDuration } from './metrics/advancedMetrics';
import {
  reconnectAttemptsTotal,
  reconnectLimitedTotal,
  reconnectQueueDepth,
} from './metrics/advancedMetrics';
import { getClusterTimeMs, getClockSnapshot, type ClusterClockSnapshot } from './ws/clusterClock';
import type { PresenceEntry } from './ws/presenceService';
import { ReconnectAdmissionController } from './ws/reconnectAdmission';

// ─────────────────────────────────────────────────────────────────────────────

const CURSOR_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
];

/** Time after which an unresponsive connection is terminated. */
const CONN_TIMEOUT_MS = 60_000;

/** Interval between periodic CRDT snapshot writes to `document_snapshots`. */
const SNAPSHOT_INTERVAL_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Auth-message type

interface AuthMessage {
  type: 'auth';
  /** JWT access token issued by the auth system. */
  accessToken: string;
  /** The file the client wants to collaborate on. */
  fileId: string;
}

function isAuthMessage(v: unknown): v is AuthMessage {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).type === 'auth' &&
    typeof (v as Record<string, unknown>).accessToken === 'string' &&
    typeof (v as Record<string, unknown>).fileId === 'string'
  );
}

/**
 * Measure event-loop lag by scheduling a setImmediate callback and recording
 * how long it actually takes to fire.  Non-zero lag indicates the event loop
 * is saturated (e.g. CPU-heavy sync work or large JSON serialisation).
 */
function measureEventLoopLag(): Promise<number> {
  return new Promise<number>((resolve) => {
    const start = performance.now();
    setImmediate(() => resolve(performance.now() - start));
  });
}

function buildWebsocketUrl(protocol: 'http' | 'https', host: string): string {
  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
  const normalizedHost = host.trim();
  return `${wsProtocol}://${normalizedHost}/ws`;
}

// ─────────────────────────────────────────────────────────────────────────────

export class CollaborationServer {
  private readonly wss: WebSocketServer;
  private readonly roomStore: RoomStore;
  private readonly persistence: RoomPersistenceService;
  private readonly permissions: PermissionGateway;
  private readonly sessionTracker: SessionTrackingService;
  private readonly subscriptionManager: DashboardSubscriptionManager;
  private readonly edgeMirrorManager: EdgeMirrorManager | null;

  /**
   * Every open WebSocket connection, including unauthenticated ones.
   * Used for pinging, timeout enforcement, and graceful shutdown.
   */
  private readonly allConnections: Map<string, ClientConnection> = new Map();

  /**
   * userId → Set<connectionId>  Tracks how many concurrent sockets each
   * authenticated user has open.  Checked at auth time to enforce
   * MAX_SESSIONS_PER_USER.  Entries are cleaned up on disconnect.
   */
  private readonly userConnectionCounts = new Map<string, Set<string>>();

  /**
   * userId → Set<ClientConnection>  Index for workspace-level permission revocation.
   * Populated when a connection authenticates; removed on disconnect.
   */
  private readonly userConnections = new Map<string, Set<ClientConnection>>();

  /**
   * connectionId → EditBurstState  Per-connection rolling-window counter
   * for the edit burst soft-throttle.  Allocated on first sync frame;
   * deleted on disconnect.
   */
  private readonly editBurstTracker = new Map<string, EditBurstState>();

  /**
   * connectionId entries that have been explicitly revoked mid-session (e.g. live
   * permission change).  Checked in the sync-frame handler as a belt-and-suspenders
   * guard even after conn.role has been downgraded to 'viewer'.  Entries are removed
   * when handleDisconnect finalises the connection.
   */
  private readonly revokedConnections = new Set<string>();

  /**
   * Tracks the periodic snapshot timer for each open room (fileId → timer).
   * Timers are started when a room is first created, cleared when the room is
   * destroyed (last disconnect, folder deletion, or graceful shutdown).
   */
  private readonly snapshotTimers = new Map<string, ReturnType<typeof setInterval>>();

  private colorIndex = 0;
  private authInProgress = 0;
  private static readonly MAX_AUTH_INFLIGHT = 100;
  private dbFailureCount = 0;
  private dbBreakerOpen = false;
  private static readonly DB_FAILURE_THRESHOLD = 5;
  private static readonly DB_BREAKER_COOLDOWN_MS = 10_000;
  private readonly pingInterval: ReturnType<typeof setInterval>;
  private readonly editFlushInterval: ReturnType<typeof setInterval>;
  /** Periodic CRDT compaction sweep. */
  private readonly compactionSweepInterval: ReturnType<typeof setInterval>;
  /** Periodic idle room eviction sweep. */
  private readonly evictionSweepInterval: ReturnType<typeof setInterval>;
  /** Enabled only when STRESS_DEBUG=true — logs server state every 5 s. */
  private stressDebugInterval: ReturnType<typeof setInterval> | undefined;
  private shuttingDown = false;
  /**
   * Tracks the currently-running flushPendingEdits() Promise.
   * Prevents a timer-fired flush from racing with the shutdown flush:
   * the shutdown path awaits this before starting its own definitive flush.
   */
  private flushInProgress: Promise<void> | null = null;

  /** LRU index for automatic room eviction. */
  private readonly roomLru = new RoomLruIndex();

  /** Token-bucket admission controller for reconnect storm mitigation. */
  private readonly reconnectAdmission = new ReconnectAdmissionController();

  /**
   * Rolling counter for total Yjs updates applied in the current 60-second
   * window.  Exposed via getEditsPerMinute() — no Prometheus, purely in-memory.
   */
  private rollingEdits: { count: number; windowStart: number } = {
    count: 0,
    windowStart: Date.now(),
  };

  // ── Activity history ring buffer (for realtime activity graph) ────────────
  private static readonly ACTIVITY_SAMPLE_INTERVAL_MS = 5_000;
  private static readonly ACTIVITY_RING_SIZE = 60; // 60 × 5 s = 5 minutes

  private readonly activityRing: Array<{
    ts: number;
    editsPerMinute: number;
    connections: number;
    activeRooms: number;
    editors: number;
    viewers: number;
  }> = [];
  private activityRingCursor = 0;
  private activitySamplerInterval: ReturnType<typeof setInterval> | undefined;

  constructor(
    roomStore: RoomStore = new InMemoryRoomStore(),
    persistence: RoomPersistenceService = new DefaultRoomPersistenceService(),
    permissions: PermissionGateway = new WorkspacePermissionGateway(),
    sessionTracker: SessionTrackingService = defaultSessionTracker,
    subscriptionManager: DashboardSubscriptionManager = defaultSubscriptionManager,
  ) {
    this.roomStore = roomStore;
    this.persistence = persistence;
    this.permissions = permissions;
    this.sessionTracker = sessionTracker;
    this.subscriptionManager = subscriptionManager;
    this.edgeMirrorManager = null;

    // Wire distributed presence fan-out only when backed by Redis.
    // In-memory mode needs no cross-node coordination.
    if (this.roomStore instanceof RedisRoomStore) {
      const redisRoomStore = this.roomStore;
      this.edgeMirrorManager = new EdgeMirrorManager({
        onMirrorEvicted: (fileId) => {
          redisRoomStore.unregisterRoomStream(fileId);
        },
      });

      redisRoomStore.onRemotePresence = (fileId, rawMsg) =>
        this.applyRemotePresence(fileId, rawMsg);

      // UPGRADE 2: Wire Redis Streams consumer — apply remote CRDT updates
      redisRoomStore.onRemoteStreamUpdate = (fileId, update, publishTimestampMs) => {
        const room = redisRoomStore.get(fileId);
        if (!room) {
          this.edgeMirrorManager?.applyStreamUpdate(fileId, update, publishTimestampMs);
          return;
        }
        try {
          room.applyRemoteUpdate(update);
        } catch (err) {
          byzantineRejectionsCounter.inc({ reason: 'protocol_invalid' });
          getLogger().warn({ err, fileId }, '[streams] failed to apply remote stream update');
        }
      };

      redisRoomStore.onForwardedWrite = (request) => this.handleForwardedWriteRequest(request);
    }

    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => this.handleConnection(ws, req));

    this.pingInterval = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
    this.editFlushInterval = setInterval(
      () => void this.flushPendingEdits(),
      EDIT_FLUSH_INTERVAL_MS,
    );

    // Periodic CRDT compaction sweep — evaluates all rooms for tombstone removal
    this.compactionSweepInterval = setInterval(
      () => void this.runCompactionSweep(),
      COMPACTION_SWEEP_INTERVAL_MS,
    );

    // Periodic idle room eviction sweep — LRU-evicts rooms with zero connections
    this.evictionSweepInterval = setInterval(
      () => void this.runEvictionSweep(),
      EVICTION_SWEEP_INTERVAL_MS,
    );

    // ── Activity history sampler ──────────────────────────────────────────
    this.activitySamplerInterval = setInterval(() => {
      this.sampleActivitySnapshot();
    }, CollaborationServer.ACTIVITY_SAMPLE_INTERVAL_MS);

    if (process.env.STRESS_DEBUG === 'true') {
      this.stressDebugInterval = setInterval(() => {
        const m = process.memoryUsage();
        getLogger().info(
          {
            connections: this.allConnections.size,
            sessions: this.getSessionCount(),
            rooms: this.roomStore.size,
            userConnectionMapSize: this.userConnectionCounts.size,
            burstTrackerSize: this.editBurstTracker.size,
            sessionTrackerSize: this.sessionTracker.size,
            editsPerMinute: this.getEditsPerMinute(),
            memory: { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal },
          },
          '[stress-debug] server state',
        );
      }, 5_000);
    }
  }

  // ── HTTP-upgrade entry point ──────────────────────────────────────────────

  /**
   * Called by `app.server.on('upgrade', ...)` in index.ts.
   * Rejects non-/ws paths at the socket level before the WS handshake.
   */
  async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
    });
  }

  // ── Per-connection lifecycle ──────────────────────────────────────────────

  private handleConnection(ws: WebSocket, req?: IncomingMessage): void {
    // ── Reconnect admission control ─────────────────────────────────────
    reconnectAttemptsTotal.inc();
    reconnectQueueDepth.set(this.reconnectAdmission.getQueueDepth());

    const admission = this.reconnectAdmission.tryAdmit();
    if (!admission.admitted) {
      reconnectLimitedTotal.inc();
      this.reconnectAdmission.incrementQueueDepth();
      reconnectQueueDepth.set(this.reconnectAdmission.getQueueDepth());

      // Send retry-after hint then close with 1013 "Try Again Later"
      const payload = JSON.stringify({
        type: 'retry_after',
        retryAfterMs: admission.retryAfterMs,
      });
      try {
        ws.send(payload, () => {
          ws.close(1013, 'Server busy — retry later');
          this.reconnectAdmission.decrementQueueDepth();
          reconnectQueueDepth.set(this.reconnectAdmission.getQueueDepth());
        });
      } catch {
        try { ws.close(1013, 'Server busy'); } catch {}
        this.reconnectAdmission.decrementQueueDepth();
        reconnectQueueDepth.set(this.reconnectAdmission.getQueueDepth());
      }
      return;
    }

    const connectionId = randomUUID();
    const color = CURSOR_COLORS[this.colorIndex % CURSOR_COLORS.length] as string;
    this.colorIndex++;

    // Propagate or generate correlation trace ID from the HTTP upgrade request
    const incomingTrace = req?.headers['x-trace-id'];
    const traceId = (typeof incomingTrace === 'string' && incomingTrace.length > 0)
      ? incomingTrace
      : randomUUID();
    const connLog = getLogger().child({ connectionId, traceId });

    const conn: ClientConnection = {
      ws,
      connectionId,
      disconnected: false,
      sessionStarted: false,
      color,
      joinedAt: getClusterTimeMs(),
      lastPing: getClusterTimeMs(),
      traceId,
      log: connLog,
      backpressure: createBackpressureState(),
    };

    this.allConnections.set(connectionId, conn);
    connectionsOpenedCounter.inc();

    // Unauthenticated connections must send an auth message within the deadline
    conn.authTimeout = setTimeout(() => {
      if (!conn.userId) {
        this.sendJson(conn, { type: 'auth_error', reason: 'auth_timeout' });
        ws.close(1008, 'Auth timeout');
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      wsMessagesReceivedCounter.inc();
      // ── Guard 1: hard message-size cap ────────────────────────────────
      const byteLength = getRawDataByteLength(data);
      if (byteLength > MAX_MESSAGE_BYTES) {
        conn.log.warn(
          { byteLength },
          'WS message exceeded size limit — closing with 1009',
        );
        ws.close(1009, 'Message Too Big');
        void this.handleDisconnect(conn);
        return;
      }

      if (!conn.userId) {
        // Not yet authenticated — only accept auth frames
        void this.handleAuthMessage(conn, data, isBinary);
        return;
      }
      void this.handleDataMessage(conn, data, isBinary);
    });

    ws.on('pong', () => {
      conn.lastPing = getClusterTimeMs();
    });

    ws.on('close', () => {
      this.handleDisconnect(conn).catch((err) => {
        conn.log.error(
          { err },
          'handleDisconnect threw unexpectedly',
        );
      });
    });

    ws.on('error', (err) => {
      conn.log.error({ err }, 'WebSocket error');
      void this.handleDisconnect(conn);
    });
  }

  // ── Authentication ────────────────────────────────────────────────────────

  private async handleAuthMessage(
    conn: ClientConnection,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (this.authInProgress >= CollaborationServer.MAX_AUTH_INFLIGHT) {
      conn.log.warn({ connectionId: conn.connectionId }, 'Auth rejected — server busy');
      try { conn.ws.close(1013, 'Server busy'); } catch {}
      return;
    }
    if (this.dbBreakerOpen) {
      conn.log.error('DB breaker open — rejecting auth');
      try { conn.ws.close(1013, 'Database unavailable'); } catch {}
      return;
    }
    this.authInProgress++;
    try {
    if (isBinary) {
      this.sendJson(conn, { type: 'auth_error', reason: 'unauthorized' });
      conn.ws.close(1008, 'First message must be auth JSON');
      return;
    }

    let parsed: unknown;
    try {
      const raw = typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8');
      parsed = JSON.parse(raw);
    } catch {
      this.sendJson(conn, { type: 'auth_error', reason: 'unauthorized' });
      conn.ws.close(1008, 'Invalid auth payload');
      return;
    }

    if (!isAuthMessage(parsed)) {
      this.sendJson(conn, { type: 'auth_error', reason: 'unauthorized' });
      conn.ws.close(1008, 'Invalid auth message');
      return;
    }

    const auth = parsed;

    try {
      const tokenPayload = await verifyAccessToken(auth.accessToken);
      const userId = tokenPayload.sub;

      const role = await this.permissions.getRoleForFile(userId, auth.fileId)
        .catch((err: unknown) => { this.recordDbFailure(); throw err; });
      if (!role) {
        this.sendJson(conn, { type: 'auth_error', reason: 'unauthorized' });
        conn.ws.close(1008, 'Unauthorized');
        return;
      }

      // ── Guard 2: max concurrent sessions per user ──────────────────────
      const existingConns = this.userConnectionCounts.get(userId);
      if (existingConns && existingConns.size >= MAX_SESSIONS_PER_USER) {
        conn.log.warn(
          { userId, activeCount: existingConns.size },
          'Auth rejected — max concurrent sessions per user exceeded',
        );
        this.sendJson(conn, { type: 'error', message: 'Maximum concurrent sessions exceeded.' });
        conn.ws.close(4001, 'Maximum concurrent sessions exceeded.');
        return;
      }

      // Register BEFORE any further async work so concurrent auth requests
      // for the same userId see the accurate count immediately.
      const userConns = existingConns ?? new Set<string>();
      if (!existingConns) this.userConnectionCounts.set(userId, userConns);
      userConns.add(conn.connectionId);

      // Index by userId for workspace-level revocation lookups
      const connSet = this.userConnections.get(userId) ?? new Set<ClientConnection>();
      if (!this.userConnections.has(userId)) this.userConnections.set(userId, connSet);
      connSet.add(conn);

      // Populate connection with authenticated identity
      conn.userId = userId;
      conn.fileId = auth.fileId;
      conn.role = role;
      conn.displayName = tokenPayload.displayName;
      conn.email = tokenPayload.email;

      if (conn.authTimeout) {
        clearTimeout(conn.authTimeout);
        conn.authTimeout = undefined;
      }

      // Join an owner room or non-owner edge mirror for this file
      let room: Room;
      if (
        this.roomStore instanceof RedisRoomStore &&
        this.edgeMirrorManager &&
        !this.roomStore.isRoomOwner(auth.fileId)
      ) {
        room = await this.edgeMirrorManager.getOrCreate(auth.fileId, async () => {
          let state = await this.persistence.loadYdocState(auth.fileId);
          if (!state) {
            state = await loadSnapshot(auth.fileId);
          }
          return new Room(state);
        }).catch((err: unknown) => { this.recordDbFailure(); throw err; });
        this.edgeMirrorManager.addReader(auth.fileId);
        conn.servedByMirror = true;
        await this.roomStore.registerRoomStream(auth.fileId);
      } else {
        room = await this.getOrCreateRoom(auth.fileId)
          .catch((err: unknown) => { this.recordDbFailure(); throw err; });
        conn.servedByMirror = false;
      }

      room.addConnection(conn);
      this.recordDbSuccess();
      activeSessionsGauge.inc();

      // Log activity non-fatally — never block the auth response for this
      this.persistence
        .logActivity(userId, 'user_joined_file', auth.fileId, {
          displayName: tokenPayload.displayName,
        })
        .catch((err) => {
          conn.log.error(
            { err, fileId: auth.fileId, userId },
            'Failed to log join activity',
          );
        });

      // Acknowledge to the client
      this.sendJson(conn, {
        type: 'auth_success',
        userId,
        role,
        color: conn.color,
      });

      // Notify already-connected peers that a new user joined
      room.broadcastJson(
        {
          type: 'user_joined',
          userId,
          displayName: tokenPayload.displayName,
          color: conn.color,
        },
        conn.connectionId,
      );

      // Register in-memory session for the dashboard — non-fatal if it fails
      this.permissions
        .getFolderIdForFile(auth.fileId)
        .then((workspaceId) => {
          if (workspaceId) {
            conn.workspaceId = workspaceId;
            this.sessionTracker.createSession(
              conn.connectionId,
              userId,
              workspaceId,
              auth.fileId,
            );
            // Immediately push updated presence to any dashboard subscribers
            this.subscriptionManager.notifyWorkspaceUpdate(workspaceId, true);
          }
        })
        .catch((err) => {
          this.recordDbFailure();
          conn.log.warn(
            { err, fileId: auth.fileId, userId },
            'getFolderIdForFile failed — session not tracked',
          );
        });

      // Initiate Yjs sync: server sends sync step 1
      this.startYjsSync(conn, room);

      conn.log.info(
        { userId, fileId: auth.fileId, role },
        'WebSocket authenticated',
      );
    } catch (err) {
      conn.log.warn({ err }, 'WebSocket auth failed');
      this.sendJson(conn, { type: 'auth_error', reason: 'unauthorized' });
      conn.ws.close(1008, 'Unauthorized');
    }
    } finally {
      this.authInProgress = Math.max(0, this.authInProgress - 1);
    }
  }

  // ── DB circuit breaker ────────────────────────────────────────────────────

  private recordDbFailure(): void {
    this.dbFailureCount++;
    if (!this.dbBreakerOpen && this.dbFailureCount >= CollaborationServer.DB_FAILURE_THRESHOLD) {
      this.dbBreakerOpen = true;
      getLogger().error(
        { dbFailureCount: this.dbFailureCount },
        'DB circuit breaker opened — database appears unavailable',
      );
      setTimeout(() => {
        this.dbFailureCount = 0;
        this.dbBreakerOpen = false;
        getLogger().info('DB circuit breaker closed — retrying database connections');
      }, CollaborationServer.DB_BREAKER_COOLDOWN_MS);
    }
  }

  private recordDbSuccess(): void {
    this.dbFailureCount = 0;
  }

  /**
   * Send the server's Yjs state vector to the new client (sync step 1) so the
   * client can respond with any updates the server is missing (sync step 2).
   * Also push the current awareness snapshot so existing cursors appear immediately.
   */
  private startYjsSync(conn: ClientConnection, room: Room): void {
    this.sendBinary(conn, room.buildSyncStep1Message());
    const awarenessMsg = room.buildAwarenessMessage();
    if (awarenessMsg) this.sendBinary(conn, awarenessMsg);
  }

  // ── Room management ───────────────────────────────────────────────────────

  private getOrCreateRoom(fileId: string): Promise<Room> {
    const existing = this.roomStore.get(fileId);
    if (existing?.state === 'destroying') {
      // The room is actively being torn down; reject so the caller closes the socket
      return Promise.reject(new Error(`Room for file ${fileId} is in destroying state`));
    }
    return this.roomStore.getOrCreate(fileId, async () => {
      // ── 1. Load persisted state ────────────────────────────────────────
      // Try the primary files-table state first (saved by the existing periodic
      // flush).  Fall back to the document_snapshots table so that a room
      // created after an idle eviction still restores the last-known CRDT state.
      let state = await this.persistence.loadYdocState(fileId);
      if (!state) {
        state = await loadSnapshot(fileId);
      }

      const room = new Room(state);
      room.activate();
      room.refreshEstimatedSize();
      activeRoomsGauge.inc();

      // Register in the LRU index for automatic eviction
      this.roomLru.touch(fileId, room.estimatedSize);

      // ── 2. Start periodic snapshot timer ──────────────────────────────
      // Every SNAPSHOT_INTERVAL_MS, encode the current Y.Doc state and UPSERT
      // it into `document_snapshots`.  Runs independently of the existing
      // EDIT_FLUSH_INTERVAL save so the snapshot table always holds a recent
      // baseline even if the room never transitions back to idle.
      const snapshotTimer = setInterval(() => {
        if (!room.dirty) return;
        const snapshotBuf = room.encodeStateAsUpdate();
        enqueueSnapshot(fileId, snapshotBuf);
        // Fire-and-forget version capture (coalesced internally)
        void autoCapture(fileId, snapshotBuf).catch(() => {});
      }, SNAPSHOT_INTERVAL_MS);
      this.snapshotTimers.set(fileId, snapshotTimer);

      // UPGRADE 2: Register room with Redis Streams consumer for cross-node sync
      if (this.roomStore instanceof RedisRoomStore) {
        void this.roomStore.registerRoomStream(fileId);
      }

      return room;
    });
  }

  private async handleForwardedWriteRequest(
    request: ForwardedWriteRequest,
  ): Promise<{ success: boolean; seq?: bigint; error?: string }> {
    try {
      if (!(this.roomStore instanceof RedisRoomStore)) {
        return { success: false, error: 'forward_write_requires_redis_store' };
      }

      const room = await this.getOrCreateRoom(request.fileId);
      const rawUpdate = Buffer.from(request.updateBase64, 'base64');

      const walT0 = performance.now();
      const seq = await appendUpdate(request.fileId, rawUpdate);
      const walMs = performance.now() - walT0;
      walAppendLatency.observe(walMs);

      if (seq === null) {
        return { success: false, error: 'wal_append_failed' };
      }

      room.applyClientUpdate(new Uint8Array(rawUpdate), '\x00__forwarded__\x00');
      await this.roomStore.publishStreamUpdate(request.fileId, new Uint8Array(rawUpdate));

      return { success: true, seq };
    } catch (err) {
      getLogger().warn({ err, fileId: request.fileId }, 'Failed to apply forwarded write on owner');
      return { success: false, error: 'forwarded_write_apply_failed' };
    }
  }

  // ── Data message routing (post-auth) ─────────────────────────────────────

  private async handleDataMessage(
    conn: ClientConnection,
    rawData: RawData,
    isBinary: boolean,
  ): Promise<void> {
    // Belt-and-suspenders: drop frames for connections mid-teardown
    if (conn.disconnected) return;
    if (!conn.fileId || !conn.userId || !conn.role) return;

    // ── Workspace-file invariant guard ───────────────────────────────────
    // The session entry is created during auth after the DB has confirmed
    // that fileId belongs to a workspace the user may access.  If the entry
    // is absent the socket is in a torn state (e.g. raced with disconnect)
    // and must not mutate any Yjs room.  Entirely in-memory — zero DB calls.
    const liveSession = this.sessionTracker.getSession(conn.connectionId);
    if (!liveSession) {
      conn.log.warn(
        { fileId: conn.fileId, userId: conn.userId },
        'Workspace-file invariant: no live session — frame dropped',
      );
      return;
    }

    // Text frames carry JSON control messages (e.g. subscribe_dashboard)
    if (!isBinary) {
      this.handleJsonDataMessage(conn, rawData);
      return;
    }

    const room = conn.servedByMirror
      ? this.edgeMirrorManager?.get(conn.fileId)
      : this.roomStore.get(conn.fileId);
    if (!room) return;

    const buf = rawData instanceof Buffer ? rawData : Buffer.from(rawData as ArrayBuffer);
    const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    if (uint8.length === 0) return;

    // First byte is the varint message type.
    // All defined values (MSG_SYNC=0, MSG_AWARENESS=1) are < 128, so single-byte.
    const msgType = uint8[0];

    if (msgType === MSG_SYNC) {
      const canWrite = conn.role === 'owner' || conn.role === 'editor';

      // ── Guard 3: edit burst soft-throttle ─────────────────────────────
      // Viewers never write, so they are exempt. Writers are allowed
      // EDIT_BURST_MAX sync frames per EDIT_BURST_WINDOW_MS; excess frames
      // are dropped (no disconnect, no Yjs state mutation).  The warning
      // fires at most once per second per connection (firstDrop flag).
      if (canWrite) {
        const burst = isEditThrottled(this.editBurstTracker, conn.connectionId);
        if (burst.drop) {
          if (burst.firstDrop) {
            conn.log.warn(
              { userId: conn.userId, limit: 50 },
              'Edit burst throttle: dropping excess sync frames for this second',
            );
          }
          return;
        }
      }

      // ── Guard 6: connection explicitly revoked mid-session ───────────
      // conn.role is already 'viewer' after revocation, but this Set-check
      // survives any hypothetical role-restoration race on a different code path.
      if (this.revokedConnections.has(conn.connectionId)) {
        conn.log.warn(
          { userId: conn.userId, fileId: conn.fileId },
          'Dropping sync frame — connection has been revoked',
        );
        try { conn.ws.close(1008, 'Permission revoked'); } catch { /* ignore */ }
        return;
      }

      // ── Guard 5: reject mutations after shutdown begins ─────────────
      // Node's event loop can deliver a queued message event after shutdown()
      // has set shuttingDown=true.  Dropping it here prevents a Yjs-state
      // mutation that would diverge from what was already persisted.
      if (this.shuttingDown) {
        conn.log.warn(
          { userId: conn.userId },
          'Dropping sync message — server shutting down',
        );
        return;
      }

      // ── Guard 7: hard write-role enforcement ──────────────────────────────
      // uint8[1] is the Yjs sync sub-type: 0=syncStep1, 1=syncStep2, 2=update.
      // We only close for actual update frames (2); syncStep1 read requests from
      // viewers are still allowed through.  !canWrite covers both 'viewer' and
      // any role that is not 'owner'/'editor' (e.g. a mid-session downgrade that
      // somehow bypassed Guard 6's revokedConnections Set).
      if (!canWrite && uint8[1] === 2 /* messageYjsUpdate */) {
        conn.log.warn(
          { userId: conn.userId, fileId: conn.fileId },
          'Rejecting sync — user does not have write role',
        );
        try { conn.ws.close(1008, 'Write permission required'); } catch { /* ignore */ }
        return;
      }

      let result: ReturnType<Room['handleSyncMsg']>;
      try {
        result = room.handleSyncMsg(uint8, canWrite, conn.connectionId, conn);
      } catch (err) {
        conn.log.warn({ err, fileId: conn.fileId }, 'Invalid sync protocol message');
        byzantineRejectionsCounter.inc({ reason: 'protocol_invalid' });
        try { conn.ws.close(1008, 'Invalid protocol message'); } catch { /* ignore */ }
        return;
      }

      if (result.permissionDenied) {
        this.sendJson(conn, { type: 'error', message: 'Read-only access' });
        return;
      }

      if (result.wasUpdate && result.rawUpdate) {
        const validation = validateCrdtPayload(result.rawUpdate, conn.connectionId);
        if (!validation.valid) {
          conn.log.warn(
            { reason: validation.reason, fileId: conn.fileId },
            'Byzantine guard rejected CRDT payload',
          );
          return;
        }
      }

      if (result.reply) {
        this.sendBinary(conn, result.reply);
      }
      if (result.wasUpdate) {
        if (result.rawUpdate) {
          if (conn.servedByMirror && this.roomStore instanceof RedisRoomStore) {
            const ownerNodeId = this.roomStore.getRoomOwner(conn.fileId!);
            const seq = await this.roomStore.forwardWriteToOwner(
              conn.fileId!,
              conn.connectionId,
              result.rawUpdate,
              ownerNodeId,
            );

            if (seq === null) {
              conn.log.error(
                { fileId: conn.fileId, ownerNodeId },
                'Forwarded write failed on edge mirror node',
              );
              return;
            }

            if (conn.ws.readyState === WebSocket.OPEN) {
              const ackBuf = Buffer.alloc(9);
              ackBuf[0] = MSG_ACK;
              ackBuf.writeBigUInt64BE(seq, 1);
              try {
                conn.ws.send(ackBuf);
                wsMessagesSentCounter.inc();
              } catch { /* ignore */ }
            }
          } else {
            const walT0 = performance.now();
            const seq = await appendUpdate(conn.fileId!, Buffer.from(result.rawUpdate));
            const walMs = performance.now() - walT0;
            walAppendLatency.observe(walMs);

            if (seq === null) {
              conn.log.error(
                { fileId: conn.fileId },
                '[updateLog] WAL append failed — update dropped to preserve durability ordering',
              );
              return;
            }

            try {
              room.applyClientUpdate(result.rawUpdate, conn.connectionId);
            } catch (err) {
              conn.log.warn({ err, fileId: conn.fileId }, 'Invalid CRDT update apply from client');
              byzantineRejectionsCounter.inc({ reason: 'protocol_invalid' });
              try { conn.ws.close(1008, 'Invalid protocol message'); } catch { /* ignore */ }
              return;
            }

            // ── UPGRADE 2: Publish to Redis Stream for cross-node replication ──
            if (this.roomStore instanceof RedisRoomStore) {
              await this.roomStore.publishStreamUpdate(conn.fileId!, result.rawUpdate);
            }

            // ── Client ACK protocol ──────────────────────────────────────
            // Send an ACK frame back to the client with the WAL sequence id
            // so the client knows this update is durably persisted.
            if (conn.ws.readyState === WebSocket.OPEN) {
              const ackBuf = Buffer.alloc(9);
              ackBuf[0] = MSG_ACK;
              ackBuf.writeBigUInt64BE(seq, 1);
              try {
                conn.ws.send(ackBuf);
                clientAckLatency.observe(walMs);
                wsMessagesSentCounter.inc();
              } catch { /* ignore */ }
            }
          }
        }
        // ── Rolling edits-per-minute counter ──────────────────────────────
        const rNow = Date.now();
        if (rNow - this.rollingEdits.windowStart >= 60_000) {
          this.rollingEdits.count = 0;
          this.rollingEdits.windowStart = rNow;
        }
        this.rollingEdits.count += 1;

        // Lazily start the edit session on the user's very first write
        if (!conn.sessionStarted) {
          conn.sessionStarted = true;
          this.persistence.startSession(conn.fileId!, conn.userId!).catch((err) => {
            conn.log.error(
              { err, fileId: conn.fileId, userId: conn.userId },
              'Failed to start edit session',
            );
          });
        }
        room.trackEdit(conn.userId!);
        // Update LRU activity timestamp
        this.roomLru.touch(conn.fileId!);
        // Update in-memory session counters for the presence dashboard
        this.sessionTracker.recordEdit(conn.connectionId);
        // Debounced dashboard broadcast (coalesces bursts of rapid edits)
        const editSess = this.sessionTracker.getSession(conn.connectionId);
        if (editSess) {
          this.subscriptionManager.notifyWorkspaceUpdate(editSess.workspaceId);
        }
      }
      return;
    }

    if (msgType === MSG_AWARENESS) {
      try {
        room.handleAwarenessMsg(uint8, conn);
      } catch (err) {
        conn.log.warn({ err, fileId: conn.fileId }, 'Invalid awareness protocol message');
        byzantineRejectionsCounter.inc({ reason: 'protocol_invalid' });
        try { conn.ws.close(1008, 'Invalid protocol message'); } catch { /* ignore */ }
        return;
      }
      // Fan out to other nodes when running in distributed (Redis) mode.
      // Only publish messages that originated from a real local client—not
      // updates that we have just applied from Redis ourselves (those arrive
      // via the onRemotePresence callback path, not through handleDataMessage).
      if (this.roomStore instanceof RedisRoomStore) {
        this.roomStore.publishPresence(conn.fileId!, conn.connectionId, uint8);
      }
    }
  }

  /**
   * Apply a Yjs awareness update that arrived from a remote node via Redis
   * Pub/Sub (`presence:<fileId>`).
   *
   * Finds the local Room for `fileId` and calls `handleAwarenessMsg` with a
   * synthetic "remote" connection so the update is applied to the awareness
   * instance AND broadcast to all locally-connected clients.
   *
   * The synthetic connectionId (`'\x00__redis__\x00'`) cannot match any live
   * connection (which are crypto.randomUUID() values), so `broadcastBinary`'s
   * exclude-sender logic never suppresses the fan-out.
   *
   * This path is never re-published to Redis — it is not triggered by
   * handleDataMessage and therefore the `instanceof RedisRoomStore` publish
   * guard in that path is never reached.
   */
  private applyRemotePresence(fileId: string, rawMsg: Uint8Array): void {
    const room = this.roomStore.get(fileId);
    if (!room) return;

    // Synthetic connection: no real WS backing; impossible connectionId so
    // broadcastBinary sends to every local client; no awarenessClientId
    // so Room does not register this "connection" for cleanup on disconnect.
    const remoteConn = {
      connectionId:      '\x00__redis__\x00',
      ws:                null as unknown as WebSocket,
      awarenessClientId: undefined,
    } as unknown as ClientConnection;

    try {
      room.handleAwarenessMsg(rawMsg, remoteConn);
    } catch (err) {
      getLogger().warn({ err, fileId }, 'Dropped malformed remote presence frame');
      byzantineRejectionsCounter.inc({ reason: 'protocol_invalid' });
    }
  }

  // ── JSON control message routing (post-auth, text frames) ───────────────

  /**
   * Handle JSON (text) frames sent after authentication.  Currently supports:
   *   • { type: 'subscribe_dashboard', workspaceId: string }
   *
   * Binary Yjs frames are handled in handleDataMessage above — this method is
   * only reached when `isBinary === false`.
   */
  private handleJsonDataMessage(conn: ClientConnection, rawData: RawData): void {
    // ── Guard 4: oversized JSON control frame ─────────────────────────────
    const ctrlByteLength =
      typeof rawData === 'string'
        ? Buffer.byteLength(rawData, 'utf8')
        : getRawDataByteLength(rawData);
    if (ctrlByteLength > MAX_JSON_CONTROL_BYTES) {
      conn.log.warn(
        { byteLength: ctrlByteLength },
        'JSON control frame exceeded size limit — frame dropped',
      );
      return;
    }

    let parsed: unknown;
    try {
      const raw =
        typeof rawData === 'string'
          ? rawData
          : Buffer.from(rawData as Buffer).toString('utf8');
      parsed = JSON.parse(raw);
    } catch {
      // Authenticated connection sent a text frame that is not valid JSON.
      // Close with 1008 (Policy Violation) — same as the type-whitelist guard.
      conn.ws.close(1008, 'Malformed JSON');
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) return;
    const msg = parsed as Record<string, unknown>;

    // ── Strict type whitelist ─────────────────────────────────────────────
    // Reject any message whose type field is not in the known-safe set.
    // Unknown types could indicate probing or a protocol mismatch; closing
    // with 1008 signals a policy violation without leaking internal state.
    const incomingType = msg['type'];
    if (
      typeof incomingType !== 'string' ||
      !KNOWN_JSON_CONTROL_TYPES.has(incomingType as never)
    ) {
      conn.log.warn(
        { incomingType },
        'Unknown JSON control message type — closing connection',
      );
      conn.ws.close(1008, 'Invalid message type');
      return;
    }

    if (msg['type'] === 'subscribe_dashboard') {
      const workspaceId = msg['workspaceId'];
      // Require a well-formed UUID — rejects empty strings, path traversal,
      // and injection payloads that rely on unusual characters.
      if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
        this.sendJson(conn, {
          type: 'error',
          message: 'subscribe_dashboard: workspaceId is required',
        });
        return;
      }

      // Only workspace owners ("manager" equivalent) may receive live dashboard feeds
      if (conn.role !== 'owner') {
        this.sendJson(conn, {
          type: 'error',
          message: 'subscribe_dashboard: insufficient permissions (owner required)',
        });
        return;
      }

      // Verify the connection's authenticated session belongs to the requested workspace.
      // This prevents a compromised token from subscribing to a foreign workspace.
      const session = this.sessionTracker.getSession(conn.connectionId);
      if (!session || session.workspaceId !== workspaceId) {
        this.sendJson(conn, {
          type: 'error',
          message: 'subscribe_dashboard: workspace mismatch or session not ready',
        });
        return;
      }

      this.subscriptionManager.subscribe(conn, workspaceId);
      this.sendJson(conn, { type: 'subscribe_dashboard_ack', workspaceId });

      // Push the current snapshot immediately so the client has data without waiting
      // for the next state-change event.
      this.subscriptionManager.notifyWorkspaceUpdate(workspaceId, true);
      return;
    }
    // Unknown message type — silently drop (extensions can add more cases here)
  }

  // ── Disconnect ────────────────────────────────────────────────────────────

  private async handleDisconnect(conn: ClientConnection): Promise<void> {
    // Guard: 'error' fires before 'close'; prevent double-processing
    if (conn.disconnected) return;
    conn.disconnected = true;

    const { connectionId, fileId, userId } = conn;

    if (conn.authTimeout) {
      clearTimeout(conn.authTimeout);
      conn.authTimeout = undefined;
    }

    this.allConnections.delete(connectionId);
    connectionsClosedCounter.inc();

    // ── Guardrails cleanup ────────────────────────────────────────────────
    // Always delete burst state (connectionId key is safe to delete regardless
    // of whether auth completed).  Only clean up userConnectionCounts when we
    // have a confirmed userId.
    this.editBurstTracker.delete(connectionId);
    this.revokedConnections.delete(connectionId);
    if (userId) {
      const userConns = this.userConnectionCounts.get(userId);
      if (userConns) {
        userConns.delete(connectionId);
        if (userConns.size === 0) this.userConnectionCounts.delete(userId);
      }
      const connSet = this.userConnections.get(userId);
      if (connSet) {
        connSet.delete(conn);
        if (connSet.size === 0) this.userConnections.delete(userId);
      }
    }

    // If auth never completed there is nothing room-related to clean up
    if (!fileId || !userId) return;
    activeSessionsGauge.dec();

    conn.log.info({ userId, fileId }, 'WebSocket disconnected');

    const room = conn.servedByMirror
      ? this.edgeMirrorManager?.get(fileId)
      : this.roomStore.get(fileId);
    if (room) {
      // Fix over original: remove the client's OWN awareness state (not ydoc.clientID)
      if (conn.awarenessClientId !== undefined) {
        room.removeAwarenessStates([conn.awarenessClientId]);
      }

      room.removeConnection(connectionId);
      if (conn.servedByMirror) {
        this.edgeMirrorManager?.removeReader(fileId);
      }
      room.broadcastJson({ type: 'user_left', userId }, connectionId);

      // Determine whether this user still has another tab open on the same file
      const userStillPresent = Array.from(room.getConnections().values()).some(
        (c) => c.userId === userId,
      );

      if (!userStillPresent) {
        // Flush this user's pending edit counter before the room might be destroyed
        const pending = room.drainUserPendingEdits(userId);
        if (pending) {
          await this.flushUserEdits(fileId, userId, pending.count, pending.updateLastEdited);
        }
      }

      // Save and close the room when no connections remain
      if (room.connectionCount === 0 && !this.shuttingDown) {
        room.markIdle();

        if (conn.servedByMirror) {
          conn.log.info({ fileId }, 'Edge mirror became idle — waiting for eviction timeout');
        } else {
          // ── Clear snapshot timer and persist a final snapshot ─────────────────
          // The snapshot write is fire-and-forget (errors logged inside saveSnapshot).
          // It runs unconditionally so the snapshot table always reflects the last
          // state before a room is evicted from memory.
          const snapTimer = this.snapshotTimers.get(fileId);
          if (snapTimer) {
            clearInterval(snapTimer);
            this.snapshotTimers.delete(fileId);
          }
          enqueueSnapshot(fileId, room.encodeStateAsUpdate());

          try {
            await room.runSave(async (state) => {
              await this.persistence.saveYdocState(fileId, state);
            });
          } catch (err) {
            conn.log.error({ err, fileId }, 'Failed to save room on last disconnect');
          }
          this.roomStore.delete(fileId);
          room.destroy();
          activeRoomsGauge.dec();
          // Clean up LRU and compaction tracking
          this.roomLru.remove(fileId);
          clearCompactionState(fileId);
          clearCaptureState(fileId);
          // UPGRADE 2: Unregister from stream consumer
          if (this.roomStore instanceof RedisRoomStore) {
            this.roomStore.unregisterRoomStream(fileId);
          }
          conn.log.info({ fileId }, 'Room closed — no remaining connections');
        }
      }

      // UPGRADE 3: Clean up presence rate limiter for disconnected users
      if (this.roomStore instanceof RedisRoomStore) {
        this.roomStore.getPresenceRateLimiter().remove(conn.connectionId);
      }

      // End the edit session only when the user has no remaining connections to this file
      if (!userStillPresent && conn.sessionStarted) {
        try {
          await this.persistence.endSession(fileId, userId);
        } catch (err) {
          conn.log.error({ err, fileId, userId }, 'Failed to end edit session');
        }
      }
    }

    // Activity log (non-fatal)
    this.persistence.logActivity(userId, 'user_left_file', fileId, {}).catch((err) => {
      conn.log.error({ err, fileId, userId }, 'Failed to log disconnect activity');
    });

    // Remove dashboard subscription and snapshot the full session BEFORE it is
    // deleted — both history persistence and presence broadcast need the data.
    this.subscriptionManager.unsubscribe(conn);
    const completedSession = this.sessionTracker.getSession(connectionId);

    // Persist history record — non-fatal, never blocks the disconnect path.
    if (completedSession && conn.role) {
      sessionHistoryService
        .recordSession({
          userId: completedSession.userId,
          workspaceId: completedSession.workspaceId,
          sessionStartMs: completedSession.sessionStartTime,
          sessionEndMs: getClusterTimeMs(),
          totalEdits: completedSession.totalEdits,
          filesTouched: Array.from(completedSession.filesTouched),
          role: conn.role,
        })
        .catch(() => { /* already logged inside recordSession */ });
    }

    // Clean up in-memory session for the presence dashboard
    this.sessionTracker.removeSession(connectionId);

    // Broadcast immediately so subscribers see the user disappear without delay
    if (completedSession?.workspaceId) {
      this.subscriptionManager.notifyWorkspaceUpdate(completedSession.workspaceId, true);
    }
  }

  // ── Periodic edit flushing ────────────────────────────────────────────────

  private async flushPendingEdits(): Promise<void> {
    // If a flush is already running (e.g. a timer tick raced with shutdown),
    // skip — the in-flight flush will drain pending edits, and shutdown()
    // explicitly awaits it before calling us again for the final pass.
    if (this.flushInProgress) return;

    const doFlush = async (): Promise<void> => {
    const work: Promise<void>[] = [];

    for (const [fileId, room] of this.roomStore.getAll()) {
      // Snapshot and clear ALL users' accumulated edit counts for this room
      const pending = room.drainPendingEdits();
      for (const [userId, { count, updateLastEdited }] of pending) {
        work.push(this.flushUserEdits(fileId, userId, count, updateLastEdited));
      }

      // Periodic doc save — coerced through the save mutex so saves don't pile up
      if (room.dirty) {
        work.push(
          room
            .runSave(async (state) => {
              await this.persistence.saveYdocState(fileId, state);
            })
            .catch((err) => {
              getLogger().error({ err, fileId }, 'Periodic room save failed');
            }),
        );
      }
    }

    await Promise.allSettled(work);
    }; // end doFlush

    this.flushInProgress = doFlush().finally(() => {
      this.flushInProgress = null;
    });
    await this.flushInProgress;
  }

  private async flushUserEdits(
    fileId: string,
    userId: string,
    count: number,
    updateLastEdited: boolean,
  ): Promise<void> {
    try {
      if (count > 0) {
        await this.persistence.incrementEditsBy(fileId, userId, count);
      }
      if (updateLastEdited) {
        await this.persistence.updateLastEdited(fileId, userId);
      }
    } catch (err) {
      getLogger().warn({ err, fileId, userId }, 'Failed to flush edit counts');
    }
  }

  // ── Ping / connection-timeout enforcement ─────────────────────────────────

  private pingAll(): void {
    const now = getClusterTimeMs();

    getLogger().info(
      { activeRooms: this.roomStore.size, totalConnections: this.allConnections.size },
      'WS metrics snapshot',
    );

    for (const conn of this.allConnections.values()) {
      if (now - conn.lastPing > CONN_TIMEOUT_MS) {
        conn.log.warn(
          { userId: conn.userId },
          'Connection timed out — terminating',
        );
        conn.ws.terminate();
        this.handleDisconnect(conn).catch((err) => {
          conn.log.error(
            { err },
            'handleDisconnect threw unexpectedly',
          );
        });
        continue;
      }
      if (conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.ping();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  /**
   * Returns the number of Yjs updates applied server-wide in the current
   * 60-second rolling window.  Resets automatically when the window expires.
   * No Prometheus — purely for health checks and operator visibility.
   */
  getEditsPerMinute(): number {
    if (Date.now() - this.rollingEdits.windowStart >= 60_000) {
      // Window expired and nothing has incremented it — treat as zero
      return 0;
    }
    return this.rollingEdits.count;
  }

  /** Total open WebSocket connections, including unauthenticated ones. */
  getConnectionCount(): number {
    return this.allConnections.size;
  }

  // ── Activity history ring buffer ────────────────────────────────────────

  /**
   * Samples the current server state into the ring buffer.
   * Called by the activity sampler interval (every 5 s).
   */
  private sampleActivitySnapshot(): void {
    let editors = 0;
    let viewers = 0;
    for (const [, room] of this.roomStore.getAll()) {
      const dbg = room.getDebugState();
      editors += dbg.editors;
      viewers += dbg.viewers;
    }

    const sample = {
      ts: Date.now(),
      editsPerMinute: this.getEditsPerMinute(),
      connections: this.allConnections.size,
      activeRooms: this.roomStore.size,
      editors,
      viewers,
    };

    if (this.activityRing.length < CollaborationServer.ACTIVITY_RING_SIZE) {
      this.activityRing.push(sample);
    } else {
      this.activityRing[this.activityRingCursor % CollaborationServer.ACTIVITY_RING_SIZE] = sample;
    }
    this.activityRingCursor++;
  }

  /**
   * Returns the activity history ordered oldest → newest.
   * Each entry is a 5-second snapshot of edits/min, connections, rooms, editors, viewers.
   */
  getActivityHistory(): Array<{
    ts: number;
    editsPerMinute: number;
    connections: number;
    activeRooms: number;
    editors: number;
    viewers: number;
  }> {
    if (this.activityRing.length < CollaborationServer.ACTIVITY_RING_SIZE) {
      // Buffer not full yet — return in insertion order
      return [...this.activityRing];
    }
    // Rotate so oldest sample comes first
    const start = this.activityRingCursor % CollaborationServer.ACTIVITY_RING_SIZE;
    return [
      ...this.activityRing.slice(start),
      ...this.activityRing.slice(0, start),
    ];
  }

  /**
   * Authenticated connections that have fully joined a room (sessionStarted=true).
   * During S1 this should equal the number of active editors.
   */
  getSessionCount(): number {
    let count = 0;
    for (const conn of this.allConnections.values()) {
      if (conn.sessionStarted) count++;
    }
    return count;
  }

  /** Live Yjs room objects in memory. Should be 1 under S1 (one shared file). */
  getRoomCount(): number {
    return this.roomStore.size;
  }

  /**
   * Distinct authenticated users with at least one open connection.
   * Less than getConnectionCount() when users have multiple tabs.
   */
  getUserConnectionCount(): number {
    return this.userConnectionCounts.size;
  }

  /**
   * Entries in the per-connection burst-throttle tracker.
   * Allocated on first sync frame; deleted on disconnect.
   * Tracks getSessionCount() closely under normal editing load.
   */
  getBurstTrackerSize(): number {
    return this.editBurstTracker.size;
  }

  /**
   * Sessions tracked by SessionTrackingService (dashboard presence).
   * Should converge to getSessionCount() once all connections authenticate.
   */
  getSessionTrackerSize(): number {
    return this.sessionTracker.size;
  }

  // ── Admin introspection API ───────────────────────────────────────────────

  /**
   * Per-room connection and state snapshot for admin dashboards.
   *
   * Returns one entry per live room, including every connection currently
   * attached to that room.  Safe to call at any time — O(rooms × connections).
   */
  getAdminRoomsSummary(): Array<{
    fileId: string;
    state: string;
    connectionCount: number;
    dirty: boolean;
    estimatedSizeBytes: number;
    connections: Array<{
      connectionId: string;
      userId: string | undefined;
      role: string | undefined;
      joinedAt: number;
    }>;
  }> {
    const result: ReturnType<CollaborationServer['getAdminRoomsSummary']> = [];
    for (const [fileId, room] of this.roomStore.getAll()) {
      const connections: Array<{
        connectionId: string;
        userId: string | undefined;
        role: string | undefined;
        joinedAt: number;
      }> = [];
      for (const [, conn] of room.getConnections()) {
        connections.push({
          connectionId: conn.connectionId,
          userId:       conn.userId,
          role:         conn.role,
          joinedAt:     conn.joinedAt,
        });
      }
      result.push({
        fileId,
        state:              room.state,
        connectionCount:    room.connectionCount,
        dirty:              room.dirty,
        estimatedSizeBytes: room.estimatedSize,
        connections,
      });
    }
    return result;
  }

  /**
   * Lightweight per-room debug snapshot for GET /debug/rooms.
   *
   * O(rooms × connections-per-room) — no CRDT access, no locks, no DB calls.
   * Returns per-room stats plus aggregate totals.
   */
  getDebugRoomsSummary(): {
    totalRooms: number;
    totalConnections: number;
    rooms: Array<{
      roomId: string;
      state: string;
      editors: number;
      viewers: number;
      connections: number;
      mirrors: boolean;
      updatesApplied: number;
      updatesBroadcast: number;
      ownerNode: string | null;
      lastActivityTimestamp: number;
    }>;
  } {
    const rooms: Array<{
      roomId: string;
      state: string;
      editors: number;
      viewers: number;
      connections: number;
      mirrors: boolean;
      updatesApplied: number;
      updatesBroadcast: number;
      ownerNode: string | null;
      lastActivityTimestamp: number;
    }> = [];
    let totalConnections = 0;

    const isRedis = this.roomStore instanceof RedisRoomStore;

    for (const [fileId, room] of this.roomStore.getAll()) {
      const dbg = room.getDebugState();
      totalConnections += dbg.connections;

      rooms.push({
        roomId: fileId,
        state: room.state,
        editors: dbg.editors,
        viewers: dbg.viewers,
        connections: dbg.connections,
        mirrors: this.edgeMirrorManager?.has(fileId) ?? false,
        updatesApplied: dbg.updatesApplied,
        updatesBroadcast: dbg.updatesBroadcast,
        ownerNode: isRedis
          ? (this.roomStore as RedisRoomStore).getRoomOwner(fileId) ?? null
          : null,
        lastActivityTimestamp: dbg.lastActivityTimestamp,
      });
    }

    return { totalRooms: rooms.length, totalConnections, rooms };
  }

  /**
   * Cluster topology snapshot (nodeId, active peers, owned rooms).
   * Returns null when running without a RedisRoomStore (single-node mode).
   */
  getAdminClusterSummary(): {
    nodeId: string;
    activeNodes: string[];
    ownedRooms: string[];
    totalLocalRooms: number;
  } | null {
    if (this.roomStore instanceof RedisRoomStore) {
      return this.roomStore.getClusterIntrospection();
    }
    return null;
  }

  /**
   * Local in-memory presence entries for a specific room.
   * Returns an empty array when running without RedisRoomStore.
   */
  getAdminPresenceSummary(roomId: string): PresenceEntry[] {
    if (this.roomStore instanceof RedisRoomStore) {
      return this.roomStore.getPresenceStore().getRoom(roomId);
    }
    return [];
  }

  /**
   * Apply a server-originated CRDT update to a live room and broadcast it.
   * Used by administrative flows such as version restore.
   *
   * Returns false when the room is not currently loaded in memory.
   */
  applySystemUpdateToRoom(fileId: string, update: Uint8Array): boolean {
    const room = this.roomStore.get(fileId);
    if (!room) return false;
    room.applyClientUpdate(update, '__system__');
    return true;
  }

  /**
   * Full diagnostic snapshot: cluster clock, memory, event loop, process uptime.
   */
  async getAdminDiagnostics(): Promise<{
    nodeId: string | null;
    clock: ClusterClockSnapshot;
    memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
    eventLoopLagMs: number;
    uptimeSeconds: number;
    connections: number;
    sessions: number;
    rooms: number;
    editsPerMinute: number;
  }> {
    const clock  = getClockSnapshot();
    const mem    = process.memoryUsage();
    const lag    = await measureEventLoopLag();
    const nodeId = this.roomStore instanceof RedisRoomStore
      ? this.roomStore.getNodeId()
      : null;
    return {
      nodeId,
      clock,
      memory: {
        rss:      mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
      eventLoopLagMs: lag,
      uptimeSeconds:  process.uptime(),
      connections:    this.getConnectionCount(),
      sessions:       this.getSessionCount(),
      rooms:          this.getRoomCount(),
      editsPerMinute: this.getEditsPerMinute(),
    };
  }

  /**
   * Comprehensive dashboard summary for the admin panel.
   *
   * Aggregates system-wide metrics, per-room stats, per-user activity,
   * and collaboration health — all from in-memory state.
   * No DB calls, no locks.  O(rooms + connections).
   */
  getAdminDashboardSummary(): {
    system: {
      activeUsers: number;
      activeEditors: number;
      activeViewers: number;
      totalRooms: number;
      websocketConnections: number;
      editsPerMinute: number;
      uptimeSeconds: number;
      memory: { rss: number; heapUsed: number; heapTotal: number };
    };
    rooms: Array<{
      roomId: string;
      state: string;
      editors: number;
      viewers: number;
      connections: number;
      mirrors: boolean;
      updatesApplied: number;
      updatesBroadcast: number;
      ownerNode: string | null;
      lastActivityTimestamp: number;
      dirty: boolean;
      estimatedSizeBytes: number;
    }>;
    users: Array<{
      userId: string;
      displayName: string | undefined;
      email: string | undefined;
      activeConnections: number;
      currentFileId: string | undefined;
      role: string | undefined;
      sessionDurationMs: number;
      lastActivityTimestamp: number;
    }>;
    cluster: {
      mode: string;
      nodeId: string | null;
      activeNodes: string[];
      ownedRooms: string[];
    };
  } {
    const now = Date.now();
    const mem = process.memoryUsage();
    const isRedis = this.roomStore instanceof RedisRoomStore;

    // ── System totals ──────────────────────────────────────────────────────
    let totalEditors = 0;
    let totalViewers = 0;

    // ── Rooms ──────────────────────────────────────────────────────────────
    const rooms: ReturnType<CollaborationServer['getAdminDashboardSummary']>['rooms'] = [];
    for (const [fileId, room] of this.roomStore.getAll()) {
      const dbg = room.getDebugState();
      totalEditors += dbg.editors;
      totalViewers += dbg.viewers;
      rooms.push({
        roomId: fileId,
        state: room.state,
        editors: dbg.editors,
        viewers: dbg.viewers,
        connections: dbg.connections,
        mirrors: this.edgeMirrorManager?.has(fileId) ?? false,
        updatesApplied: dbg.updatesApplied,
        updatesBroadcast: dbg.updatesBroadcast,
        ownerNode: isRedis
          ? (this.roomStore as RedisRoomStore).getRoomOwner(fileId) ?? null
          : null,
        lastActivityTimestamp: dbg.lastActivityTimestamp,
        dirty: room.dirty,
        estimatedSizeBytes: room.estimatedSize,
      });
    }

    // ── Users (deduplicate by userId) ──────────────────────────────────────
    const userMap = new Map<string, {
      userId: string;
      displayName: string | undefined;
      email: string | undefined;
      connections: number;
      currentFileId: string | undefined;
      role: string | undefined;
      earliestJoin: number;
      latestPing: number;
    }>();
    for (const conn of this.allConnections.values()) {
      if (!conn.userId) continue;
      const existing = userMap.get(conn.userId);
      if (existing) {
        existing.connections++;
        if (conn.lastPing > existing.latestPing) {
          existing.latestPing = conn.lastPing;
          existing.currentFileId = conn.fileId;
          existing.role = conn.role;
        }
        if (conn.joinedAt < existing.earliestJoin) {
          existing.earliestJoin = conn.joinedAt;
        }
      } else {
        userMap.set(conn.userId, {
          userId: conn.userId,
          displayName: conn.displayName,
          email: conn.email,
          connections: 1,
          currentFileId: conn.fileId,
          role: conn.role,
          earliestJoin: conn.joinedAt,
          latestPing: conn.lastPing,
        });
      }
    }

    const users = Array.from(userMap.values()).map(u => ({
      userId: u.userId,
      displayName: u.displayName,
      email: u.email,
      activeConnections: u.connections,
      currentFileId: u.currentFileId,
      role: u.role,
      sessionDurationMs: now - u.earliestJoin,
      lastActivityTimestamp: u.latestPing,
    }));

    // ── Cluster ────────────────────────────────────────────────────────────
    const clusterInfo = isRedis
      ? this.roomStore.getClusterIntrospection()
      : null;

    return {
      system: {
        activeUsers: userMap.size,
        activeEditors: totalEditors,
        activeViewers: totalViewers,
        totalRooms: rooms.length,
        websocketConnections: this.allConnections.size,
        editsPerMinute: this.getEditsPerMinute(),
        uptimeSeconds: process.uptime(),
        memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
      },
      rooms,
      users,
      cluster: {
        mode: isRedis ? 'redis-cluster' : 'single-node',
        nodeId: clusterInfo?.nodeId ?? null,
        activeNodes: clusterInfo?.activeNodes ?? [],
        ownedRooms: clusterInfo?.ownedRooms ?? [],
      },
    };
  }

  /**
   * Resolve affinity route for a room using the active consistent-hash ring.
   *
   * Routing only influences initial websocket destination; once connected,
   * CRDT sync/WAL/Streams semantics remain unchanged.
   */
  async getRoomAffinityRoute(
    roomId: string,
    requestContext?: { protocol?: 'http' | 'https'; host?: string },
  ): Promise<{
    roomId: string;
    ownerNodeId: string | null;
    ownerAddress: string | null;
    websocketUrl: string | null;
  }> {
    if (this.roomStore instanceof RedisRoomStore) {
      const resolved = await this.roomStore.getRoomRoute(roomId);
      if (resolved.websocketUrl) return resolved;

      // Owner known but public address metadata missing — fallback to current host.
      if (requestContext?.host) {
        const protocol = requestContext.protocol ?? 'http';
        return {
          ...resolved,
          ownerAddress: requestContext.host,
          websocketUrl: buildWebsocketUrl(protocol, requestContext.host),
        };
      }
      return resolved;
    }

    // Single-node mode fallback.
    if (requestContext?.host) {
      const protocol = requestContext.protocol ?? 'http';
      return {
        roomId,
        ownerNodeId: 'single-node',
        ownerAddress: requestContext.host,
        websocketUrl: buildWebsocketUrl(protocol, requestContext.host),
      };
    }

    return {
      roomId,
      ownerNodeId: 'single-node',
      ownerAddress: null,
      websocketUrl: null,
    };
  }

  // ── Route-handler API ─────────────────────────────────────────────────────

  /**
   * Immediately close all connections for a specific (userId, fileId) pair and mark
   * them revoked so no further sync frames are accepted.  No DB call required —
   * the caller is responsible for having confirmed the permission change first.
   *
   * Called from disconnectUserFromFolder after folder confirmation, and directly
   * by any caller that already knows the concrete fileId.
   */
  handlePermissionRevoked(userId: string, fileId: string): void {
    for (const conn of this.allConnections.values()) {
      if (conn.userId !== userId || conn.fileId !== fileId) continue;

      // Synchronous write-block — happens before any await
      conn.role = 'viewer';
      this.revokedConnections.add(conn.connectionId);

      conn.log.info(
        { userId, fileId },
        'Permission revoked — closing WebSocket connection',
      );
      this.sendJson(conn, { type: 'auth_error', reason: 'permission_revoked' });
      // ws.close() triggers the 'close' handler which calls handleDisconnect
      try { conn.ws.close(1008, 'Permission revoked'); } catch { /* ignore */ }
    }
  }

  /**
   * Close all active connections for a user across an entire workspace.
   * Triggered by workspace-level permission revocation events.
   */
  handlePermissionRevokedForWorkspace(userId: string, workspaceId: string): void {
    const conns = this.userConnections.get(userId);
    if (!conns) return;
    for (const conn of conns) {
      if (conn.workspaceId !== workspaceId) continue;

      conn.log.warn(
        { userId, workspaceId },
        'Permission revoked for workspace — closing WebSocket connection',
      );
      this.sendJson(conn, { type: 'auth_error', reason: 'permission_revoked' });
      try { conn.ws.close(1008, 'Permission revoked'); } catch { /* ignore */ }
    }
  }

  /**
   * Disconnect all of a user's open connections for files inside a folder.
   * Triggered by the permission-change hook in workspacePermissionService after
   * a committed DB revocation or role downgrade to viewer.
   *
   * Synchronously write-blocks every matching connection before any await so the
   * window in which a write could slip through is zero.  Confirms folder membership
   * async then delegates to handlePermissionRevoked for the actual close.  On DB
   * failure the connection stays write-blocked as a fail-safe.
   */
  disconnectUserFromFolder(userId: string, folderId: string): void {
    for (const conn of this.allConnections.values()) {
      if (conn.userId !== userId || !conn.fileId) continue;

      // Synchronously block all writes — no DB round-trip needed for the guard
      conn.role = 'viewer';
      this.revokedConnections.add(conn.connectionId);

      // Capture before async so stale closure reads are impossible
      const fileId = conn.fileId;
      const connectionId = conn.connectionId;

      void (async () => {
        try {
          const result = await query<{ folder_id: string }>(
            'SELECT folder_id FROM files WHERE id = $1',
            [fileId],
          );
          const actualFolderId = result.rows[0]?.folder_id;
          if (actualFolderId === folderId) {
            // Confirmed — handlePermissionRevoked sends auth_error + closes socket
            this.handlePermissionRevoked(userId, fileId);
          } else {
            // File is in a different folder — undo the optimistic revocation
            this.revokedConnections.delete(connectionId);
            const newRole = await this.permissions.getRoleForFile(userId, fileId);
            if (newRole) conn.role = newRole;
          }
        } catch (err) {
          conn.log.error(
            { err, userId, folderId, fileId, connectionId },
            'disconnectUserFromFolder DB error — connection remains write-blocked as fail-safe',
          );
          // On DB failure the connection stays in revokedConnections + role='viewer'.
          // The user must reconnect once service is restored.
        }
      })();
    }
  }

  /**
   * Close every open room and disconnect every client for the given file IDs.
   * Called when an entire folder (and its files) is deleted.
   *
   * @param fileIds  Pre-queried list of file IDs belonging to the deleted folder.
   */
  closeRoomsForFolder(fileIds: string[]): void {
    for (const fileId of fileIds) {
      const room = this.roomStore.get(fileId);
      if (!room) continue;

      // Drain pending edit counts before destroying the room so they are
      // not silently lost.  The flush is fire-and-forget because the
      // folder (and its files) are being deleted — best-effort only.
      const pending = room.drainPendingEdits();
      for (const [userId, { count, updateLastEdited }] of pending) {
        void this.flushUserEdits(fileId, userId, count, updateLastEdited);
      }

      for (const conn of room.getConnections().values()) {
        this.sendJson(conn, { type: 'auth_error', reason: 'file_deleted' });
        // End active edit sessions proactively so they don't leak
        if (conn.sessionStarted && conn.userId) {
          this.persistence.endSession(fileId, conn.userId).catch(() => { /* best-effort */ });
        }
        try {
          conn.ws.close(1008, 'File deleted');
        } catch {
          /* ignore */
        }
      }

      // Clear the snapshot timer for this room before destroying
      const snapTimer = this.snapshotTimers.get(fileId);
      if (snapTimer) {
        clearInterval(snapTimer);
        this.snapshotTimers.delete(fileId);
      }

      const removed = this.roomStore.get(fileId);
      this.roomStore.delete(fileId);
      if (removed) {
        if (removed.state !== 'idle') removed.markIdle();
        removed.destroy();
        activeRoomsGauge.dec();
      }
      // Clean up LRU and compaction tracking for deleted rooms
      this.roomLru.remove(fileId);
      clearCompactionState(fileId);
      clearCaptureState(fileId);
      getLogger().info({ fileId }, 'Room force-closed — folder deleted');
    }
  }

  // ── CRDT compaction sweep ───────────────────────────────────────────────

  /**
   * Periodic sweep that evaluates all rooms for CRDT compaction.
   * Compaction removes tombstones and reduces Y.Doc memory usage.
   *
   * Eligibility criteria:
   *   1. Room is active and not currently saving.
   *   2. Estimated Y.Doc size exceeds COMPACTION_THRESHOLD_BYTES.
   *   3. Enough time has passed since the last compaction.
   */
  private async runCompactionSweep(): Promise<void> {
    if (this.shuttingDown) return;

    for (const [fileId, room] of this.roomStore.getAll()) {
      if (room.state !== 'active' || room.saving) continue;

      const docSize = room.refreshEstimatedSize();
      if (!isCompactionEligible(fileId, docSize)) continue;

      try {
        const result = compactDoc(room.getDocForReconciliation());
        if (result.performed && result.compactedState) {
          room.applyCompactedState(result.compactedState);
          recordCompaction(fileId);

          getLogger().info(
            {
              fileId,
              beforeKb: (result.beforeBytes / 1024).toFixed(1),
              afterKb: (result.afterBytes / 1024).toFixed(1),
              savings: `${((1 - result.afterBytes / result.beforeBytes) * 100).toFixed(1)}%`,
              durationMs: result.durationMs,
            },
            '[compaction] room compacted successfully',
          );

          // Audit trail (fire-and-forget)
          logCompactionEvent(fileId, result).catch(() => {});
        }
      } catch (err) {
        getLogger().error({ err, fileId }, '[compaction] sweep error for room');
      }
    }
  }

  // ── Room eviction sweep ────────────────────────────────────────────────────

  /**
   * Periodic sweep that evicts idle rooms from memory using LRU policy.
   *
   * Eviction serializes the room state to the snapshot table and frees the
   * Y.Doc.  When a new client joins, the normal getOrCreateRoom path
   * transparently reloads the snapshot from PostgreSQL.
   */
  private async runEvictionSweep(): Promise<void> {
    if (this.shuttingDown) return;

    // First, mark idle rooms in the LRU index
    for (const [fileId, room] of this.roomStore.getAll()) {
      if (room.connectionCount === 0 && room.state === 'idle') {
        this.roomLru.markIdle(fileId);
      } else if (room.connectionCount > 0) {
        this.roomLru.markActive(fileId);
      }
    }

    const plan = computeEvictionPlan(
      this.roomLru,
      MAX_ROOMS_IN_MEMORY,
      IDLE_EVICTION_TIMEOUT_MS,
    );

    if (plan.toEvict.length === 0) return;

    getLogger().info(
      { count: plan.toEvict.length, reason: plan.reason },
      '[eviction] starting eviction sweep',
    );

    for (const fileId of plan.toEvict) {
      const room = this.roomStore.get(fileId);
      if (!room || room.connectionCount > 0) {
        // Room has new connections since the plan was computed — skip
        this.roomLru.markActive(fileId);
        continue;
      }

      const evictT0 = performance.now();
      try {
        // Persist final snapshot
        enqueueSnapshot(fileId, room.encodeStateAsUpdate());

        // Clear snapshot timer
        const snapTimer = this.snapshotTimers.get(fileId);
        if (snapTimer) {
          clearInterval(snapTimer);
          this.snapshotTimers.delete(fileId);
        }

        // Save and destroy
        if (room.state !== 'idle') room.markIdle();
        this.roomStore.delete(fileId);
        room.destroy();
        activeRoomsGauge.dec();

        // Clean up tracking
        this.roomLru.remove(fileId);
        clearCompactionState(fileId);
        clearCaptureState(fileId);

        roomEvictionCounter.inc();
        roomEvictionDuration.observe(performance.now() - evictT0);

        getLogger().info({ fileId }, '[eviction] room evicted from memory');
      } catch (err) {
        getLogger().error({ err, fileId }, '[eviction] failed to evict room');
      }
    }
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    const logger = getLogger();
    logger.info('Collaboration server shutting down…');

    // Stop recurring timers before any async work so nothing new starts
    clearInterval(this.pingInterval);
    clearInterval(this.editFlushInterval);
    clearInterval(this.compactionSweepInterval);
    clearInterval(this.evictionSweepInterval);
    if (this.activitySamplerInterval) clearInterval(this.activitySamplerInterval);
    if (this.stressDebugInterval) clearInterval(this.stressDebugInterval);

    // Stop all per-room snapshot timers
    for (const timer of this.snapshotTimers.values()) clearInterval(timer);
    this.snapshotTimers.clear();

    // If a timer-fired flush was already in flight when we cleared the interval,
    // wait for it to complete before starting the definitive shutdown flush.
    // This prevents two concurrent flushes draining the same pendingEdits maps.
    if (this.flushInProgress) await this.flushInProgress;

    // Final flush — all timers stopped, no new flush can start
    await this.flushPendingEdits();

    // End all active edit sessions
    for (const conn of this.allConnections.values()) {
      if (conn.fileId && conn.userId && conn.sessionStarted) {
        await this.persistence.endSession(conn.fileId, conn.userId).catch(() => {
          /* non-fatal */
        });
      }
    }

    // Persist all dirty rooms
    for (const [fileId, room] of this.roomStore.getAll()) {
      await room
        .runSave(async (state) => {
          await this.persistence.saveYdocState(fileId, state);
        })
        .catch((err) => {
          logger.error({ err, fileId }, 'Shutdown save failed');
        });
    }

    // Enqueue final CRDT snapshots for every open room, then flush the queue
    // synchronously so no snapshot is lost before the process exits.
    for (const [fileId, room] of this.roomStore.getAll()) {
      enqueueSnapshot(fileId, room.encodeStateAsUpdate());
    }
    await drainSnapshotQueue();

    // Close all WebSocket connections gracefully
    for (const conn of this.allConnections.values()) {
      conn.disconnected = true;
      try {
        conn.ws.close(1001, 'Server shutting down');
      } catch {
        /* ignore */
      }
    }

    // Await any remaining in-progress saves, then free Yjs memory
    for (const [, room] of this.roomStore.getAll()) {
      await room.awaitSave();
      room.markIdle();
      room.destroy();
    }

    this.edgeMirrorManager?.close();

    // Release all dashboard subscription state and cancel pending debounce timers
    this.subscriptionManager.destroy();

    this.wss.close();
    logger.info('WebSocket server closed');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private sendJson(conn: ClientConnection, payload: Record<string, unknown>): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    try {
      conn.ws.send(JSON.stringify(payload));
      wsMessagesSentCounter.inc();
    } catch (err) {
      conn.log.debug({ err, type: payload.type }, 'sendJson failed — connection likely closing');
    }
  }

  private sendBinary(conn: ClientConnection, data: Uint8Array): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    try {
      conn.ws.send(data);
      wsMessagesSentCounter.inc();
    } catch (err) {
      conn.log.debug({ err, byteLength: data.byteLength }, 'sendBinary failed — connection likely closing');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level singleton
//
// Route handlers (folders.ts, permissions.ts) access the server through this
// accessor so their existing call sites need no changes.
// ─────────────────────────────────────────────────────────────────────────────

let _instance: CollaborationServer | null = null;

export function setCollaborationServerInstance(server: CollaborationServer): void {
  _instance = server;
}

export function getCollaborationServerInstance(): CollaborationServer | null {
  return _instance;
}
