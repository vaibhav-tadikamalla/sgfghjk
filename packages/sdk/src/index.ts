/**
 * @peergrid/sdk
 *
 * TypeScript client SDK for the PeerGrid collaborative editing platform.
 *
 * Quick start:
 *
 * ```ts
 * import { PeerGridClient } from '@peergrid/sdk';
 *
 * const client = new PeerGridClient({
 *   url:   'wss://your-server.example.com/ws',
 *   token: 'your-jwt-access-token',
 * });
 *
 * // Join a collaborative document room
 * const room = await client.joinRoom('doc123');
 *
 * // room.doc is a live Y.Doc — attach your shared types and observe changes
 * const yText = room.doc.getText('content');
 * yText.observe(event => console.log('text changed', event));
 *
 * // Listen for sync and close events
 * room.on('synced', ()     => console.log('fully synced with server'));
 * room.on('close',  (code) => console.log('disconnected', code));
 *
 * // Apply a local update
 * room.doc.transact(() => yText.insert(0, 'Hello PeerGrid!'));
 *
 * // Observe remote awareness (cursors / selections)
 * room.awareness.on('change', ({ added, updated, removed }) => {
 *   console.log('awareness change', added, updated, removed);
 * });
 *
 * // Leave when done
 * room.leave();
 * ```
 *
 * ## Architecture
 *
 * `PeerGridClient` manages one WebSocket connection per room and handles the
 * full Yjs v1 sync protocol:
 *
 *   1. Client sends JSON auth frame: `{ type: 'auth', accessToken, fileId }`
 *   2. Server sends binary syncStep1 (its state vector)
 *   3. Client replies with syncStep2 (full doc update the server is missing)
 *   4. Client sends its own syncStep1 to ask for the server's state
 *   5. Server replies with syncStep2 (the doc state the client is missing)
 *   6. Client emits 'synced' — the Y.Doc is now consistent with the server
 *
 * After the handshake:
 *   - Local `doc.on('update', ...)` changes are forwarded to the server as
 *     MSG_SYNC/update frames.
 *   - Incoming binary MSG_SYNC frames are applied to the local Y.Doc.
 *   - Incoming MSG_AWARENESS frames are applied to the local Awareness.
 *   - MSG_PING frames are replied to with MSG_PONG.
 *
 * Reconnection uses jittered exponential back-off (100 ms → 30 s).
 * On reconnect, the full sync handshake is repeated so no updates are lost
 * (the server WAL keeps all changes; any diverged state is reconciled by Yjs
 * CRDT merge on the next syncStep2 exchange).
 */

import * as Y                    from 'yjs';
import * as awarenessProtocol    from 'y-protocols/awareness';
import * as syncProtocol         from 'y-protocols/sync';
import * as encoding             from 'lib0/encoding';
import * as decoding             from 'lib0/decoding';

// ─── Wire protocol constants ─────────────────────────────────────────────────

const MSG_SYNC       = 0;
const MSG_AWARENESS  = 1;
// MSG_AUTH   = 2  (send only, JSON)
const MSG_PING       = 3;
const MSG_PONG       = 4;
const MSG_ACK        = 5;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PeerGridClientOptions {
  /**
   * Default websocket URL used as fallback when router resolution fails.
   * Must be a `ws://` or `wss://` URL (the server's `/ws` endpoint).
   */
  url?: string;

  /**
   * HTTP(S) router base URL used for room-affinity lookup.
   * SDK requests `${routerUrl}/route/room/:roomId` before connecting.
   */
  routerUrl?: string;

  /**
   * JWT access token obtained from the PeerGrid auth API.
   * Sent as-is to the server in the initial auth frame.
   */
  token: string;

  /**
   * Reconnect strategy — pass `false` to disable automatic reconnection.
   * Defaults to enabled with jittered exponential back-off.
   */
  reconnect?: ReconnectOptions | false;

  /**
   * Routing lookup retry strategy for `/route/room/:roomId` requests.
   */
  routing?: RoutingOptions;
}

export interface ReconnectOptions {
  /** Initial delay before first reconnect attempt (ms). Default: 100. */
  baseDelayMs?: number;
  /** Maximum delay between reconnect attempts (ms). Default: 30_000. */
  maxDelayMs?: number;
  /** Maximum number of consecutive reconnect attempts. Default: Infinity. */
  maxAttempts?: number;
}

export interface RoutingOptions {
  /** Initial retry delay in ms. Default: 100. */
  baseDelayMs?: number;
  /** Maximum retry delay in ms. Default: 5000. */
  maxDelayMs?: number;
  /** Maximum route resolution attempts. Default: 5. */
  maxAttempts?: number;
  /** Optional fetch timeout for each routing request (ms). Default: 3000. */
  requestTimeoutMs?: number;
}

interface RouteResolution {
  roomId: string;
  ownerNodeId: string | null;
  ownerAddress: string | null;
  websocketUrl: string | null;
}

interface PeerGridRoomInit {
  token: string;
  websocketUrl: string;
  reconnect?: ReconnectOptions | false;
  resolveWebsocketUrl: (roomId: string) => Promise<string>;
}

// ─── Event maps ────────────────────────────────────────────────────────────────

export interface PeerGridRoomEvents {
  /**
   * Emitted once the full Yjs sync handshake has completed on (re-)connect.
   * The Y.Doc is guaranteed to be consistent with the server from this point.
   */
  synced: [];

  /**
   * Emitted when the WebSocket connection closes, intentionally or otherwise.
   * @param code   WebSocket close code (1000 = normal, 1006 = abnormal, etc.)
   * @param reason Human-readable reason string.
   */
  close: [code: number, reason: string];

  /**
   * Emitted when the WebSocket encounters a connection error.
   */
  error: [err: Event | Error];

  /**
   * Emitted each time the room successfully (re-)connects to the server,
   * before the sync handshake begins.
   */
  connected: [];

  /**
   * Emitted when a reconnect attempt is scheduled after a disconnection.
   * @param attempt  Zero-based attempt number.
   * @param delayMs  Delay before this attempt fires.
   */
  reconnecting: [attempt: number, delayMs: number];
}

type EventKey   = keyof PeerGridRoomEvents;
type Listener<K extends EventKey> = (...args: PeerGridRoomEvents[K]) => void;

// ─── PeerGridRoom ─────────────────────────────────────────────────────────────

/**
 * A live collaborative room handle returned by `PeerGridClient.joinRoom()`.
 *
 * `room.doc` is a standard Yjs `Y.Doc` — attach shared types to it and
 * observe changes exactly as you would with any Yjs provider.
 *
 * `room.awareness` is a standard Yjs `Awareness` instance — set your local
 * state (cursor, selection, user meta) and observe remote states.
 *
 * Call `room.leave()` to disconnect and clean up all event listeners.
 */
export class PeerGridRoom {
  /** The live Yjs document for this room. Attach shared types here. */
  readonly doc: Y.Doc;
  /** Yjs awareness instance — set local state, observe remote cursors. */
  readonly awareness: awarenessProtocol.Awareness;

  private readonly fileId: string;
  private readonly token: string;
  private readonly reconnectOptions: ReconnectOptions | false | undefined;
  private readonly resolveWebsocketUrl: (roomId: string) => Promise<string>;
  private websocketUrl: string;

  private ws:              WebSocket | null = null;
  private _synced          = false;
  private _closed          = false;
  private _reconnectAttempt = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connecting = false;

  private readonly listeners: {
    [K in EventKey]?: Set<Listener<K>>;
  } = {};

  /** Called from PeerGridClient.joinRoom() — do not instantiate directly. */
  constructor(fileId: string, init: PeerGridRoomInit) {
    this.fileId  = fileId;
    this.token = init.token;
    this.reconnectOptions = init.reconnect;
    this.resolveWebsocketUrl = init.resolveWebsocketUrl;
    this.websocketUrl = init.websocketUrl;
    this.doc     = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);

    // Forward local document updates to the server
    this.doc.on('update', this._onLocalUpdate);

    // Forward local awareness changes to the server
    this.awareness.on('update', this._onLocalAwareness);
  }

  // ── Event emitter ──────────────────────────────────────────────────────────

  on<K extends EventKey>(event: K, listener: Listener<K>): this {
    if (!this.listeners[event]) {
      (this.listeners as Record<string, Set<unknown>>)[event] = new Set();
    }
    (this.listeners[event] as Set<Listener<K>>).add(listener);
    return this;
  }

  off<K extends EventKey>(event: K, listener: Listener<K>): this {
    (this.listeners[event] as Set<Listener<K>> | undefined)?.delete(listener);
    return this;
  }

  once<K extends EventKey>(event: K, listener: Listener<K>): this {
    const wrapped: Listener<K> = (...args) => {
      listener(...args);
      this.off(event, wrapped);
    };
    return this.on(event, wrapped);
  }

  private emit<K extends EventKey>(event: K, ...args: PeerGridRoomEvents[K]): void {
    const set = this.listeners[event] as Set<Listener<K>> | undefined;
    if (!set) return;
    for (const fn of set) {
      try { fn(...args); } catch { /* listener errors must not crash SDK */ }
    }
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  /** @internal — called by PeerGridClient.joinRoom() */
  _connect(): void {
    if (this._closed || this._connecting) return;
    this._connecting = true;

    void (async () => {
      try {
        this.websocketUrl = await this.resolveWebsocketUrl(this.fileId);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error('PeerGrid routing resolution failed'));
        this._connecting = false;
        if (!this._closed) this._scheduleReconnect();
        return;
      }

      if (this._closed) {
        this._connecting = false;
        return;
      }

      this.ws = new WebSocket(this.websocketUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.addEventListener('open', this._onOpen);
      this.ws.addEventListener('message', this._onMessage);
      this.ws.addEventListener('close', this._onClose);
      this.ws.addEventListener('error', this._onError);
      this._connecting = false;
    })();
  }

  /**
   * Disconnect from the server and clean up all event listeners and timers.
   * The room and its Y.Doc are NOT destroyed — you can read the final state
   * after calling leave().
   */
  leave(): void {
    this._closed = true;
    this._clearReconnectTimer();
    this._teardownWs();
    this.doc.off('update', this._onLocalUpdate);
    this.awareness.off('update', this._onLocalAwareness);
    this.awareness.destroy();
  }

  // ── WebSocket event handlers ──────────────────────────────────────────────

  private readonly _onOpen = (): void => {
    this._reconnectAttempt = 0;
    this.emit('connected');

    // Step 1: authenticate
    this._sendJson({ type: 'auth', accessToken: this.token, fileId: this.fileId });

    // Step 2: send our syncStep1 so the server can give us what we're missing
    this._sendSyncStep1();
  };

  private readonly _onMessage = (event: MessageEvent): void => {
    const raw = event.data;

    // JSON control frames (auth_error, permission_revoked, etc.)
    if (typeof raw === 'string') {
      this._handleJsonFrame(raw);
      return;
    }

    const data = new Uint8Array(raw as ArrayBuffer);
    if (data.length === 0) return;

    const decoder = decoding.createDecoder(data);
    const msgType = decoding.readVarUint(decoder);

    switch (msgType) {
      case MSG_SYNC:
        this._handleSync(data);
        break;
      case MSG_AWARENESS:
        this._handleAwareness(data);
        break;
      case MSG_PING:
        this._sendPong();
        break;
      case MSG_ACK:
        // Server confirms WAL persistence — no client action needed
        break;
      default:
        // Unknown message type: ignore silently
        break;
    }
  };

  private readonly _onClose = (event: CloseEvent): void => {
    this._synced = false;
    this.emit('close', event.code, event.reason ?? '');

    if (!this._closed) {
      this._scheduleReconnect();
    }
  };

  private readonly _onError = (event: Event): void => {
    this.emit('error', event);
  };

  // ── Protocol helpers ──────────────────────────────────────────────────────

  /**
   * Send our syncStep1 (state vector) to the server.
   * The server will respond with syncStep2 containing any updates we're missing.
   */
  private _sendSyncStep1(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this._sendBinary(encoding.toUint8Array(encoder));
  }

  /**
   * Handle an incoming MSG_SYNC frame from the server.
   *
   * - syncStep1 → reply with syncStep2 (our full state relative to server SV)
   * - syncStep2 → apply update to Y.Doc; if not yet synced, emit 'synced'
   * - update    → apply update to Y.Doc
   */
  private _handleSync(data: Uint8Array): void {
    const innerDecoder = decoding.createDecoder(data);
    decoding.readVarUint(innerDecoder); // consume MSG_SYNC prefix
    const syncType = decoding.readVarUint(innerDecoder);

    if (syncType === syncProtocol.messageYjsSyncStep1) {
      // Server is asking us to reply with the updates it might be missing.
      // This happens on initial connect AND on reconnect.
      const serverSV = decoding.readVarUint8Array(innerDecoder);
      const encoder  = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeSyncStep2(encoder, this.doc, serverSV);
      this._sendBinary(encoding.toUint8Array(encoder));

    } else if (
      syncType === syncProtocol.messageYjsSyncStep2 ||
      syncType === syncProtocol.messageYjsUpdate
    ) {
      // Apply the server's state (or an incremental update) to our local doc.
      Y.applyUpdate(this.doc, decoding.readVarUint8Array(innerDecoder), 'remote');

      // First time we receive a syncStep2 on this connection → fully synced
      if (!this._synced && syncType === syncProtocol.messageYjsSyncStep2) {
        this._synced = true;
        this.emit('synced');
      }
    }
  }

  /**
   * Handle an incoming MSG_AWARENESS frame from the server.
   */
  private _handleAwareness(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    decoding.readVarUint(decoder); // consume MSG_AWARENESS prefix
    const update = decoding.readVarUint8Array(decoder);
    awarenessProtocol.applyAwarenessUpdate(this.awareness, update, 'remote');
  }

  /**
   * Handle a JSON control frame from the server (errors, auth results, etc.).
   */
  private _handleJsonFrame(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return; // Malformed — ignore
    }

    if (msg['type'] === 'auth_error') {
      // Permanent failure — do not reconnect on auth errors
      this._closed = true;
      const reason = typeof msg['reason'] === 'string' ? msg['reason'] : 'auth_error';
      this.emit('error', new Error(`PeerGrid auth error: ${reason}`));
      this._teardownWs();
    }
  }

  // ── Local change forwarding ────────────────────────────────────────────────

  /**
   * Forward local Y.Doc updates to the server.
   * The `origin` guard prevents forwarding updates that arrived from the server
   * (they use the origin `'remote'`).
   */
  private readonly _onLocalUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === 'remote') return;        // already from server — don't echo
    if (!this._synced)        return;        // don't send before synced
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this._sendBinary(encoding.toUint8Array(encoder));
  };

  /**
   * Forward local awareness changes to the server.
   */
  private readonly _onLocalAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
  ): void => {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const changedClients = [...added, ...updated, ...removed];
    if (changedClients.length === 0) return;

    const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessUpdate);
    this._sendBinary(encoding.toUint8Array(encoder));
  };

  // ── Send helpers ──────────────────────────────────────────────────────────

  private _sendBinary(data: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(data); } catch { /* ignore — socket closed */ }
  }

  private _sendJson(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
  }

  private _sendPong(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_PONG);
    this._sendBinary(encoding.toUint8Array(encoder));
  }

  // ── Reconnect logic ───────────────────────────────────────────────────────

  private _scheduleReconnect(): void {
    const opts = this.reconnectOptions;
    if (opts === false) return; // Reconnect disabled

    const reconnectOpts = opts ?? {};
    const maxAttempts   = reconnectOpts.maxAttempts ?? Infinity;

    if (this._reconnectAttempt >= maxAttempts) {
      this.emit('error', new Error(`PeerGrid: max reconnect attempts (${maxAttempts}) reached`));
      return;
    }

    const baseDelay = reconnectOpts.baseDelayMs ?? 100;
    const maxDelay  = reconnectOpts.maxDelayMs  ?? 30_000;
    const attempt   = this._reconnectAttempt;

    // Exponential back-off with ±20% jitter
    const expDelay  = Math.min(baseDelay * 2 ** attempt, maxDelay);
    const jitter    = expDelay * 0.2 * (Math.random() * 2 - 1); // ±20%
    const delayMs   = Math.round(expDelay + jitter);

    this._reconnectAttempt++;
    this.emit('reconnecting', attempt, delayMs);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closed) this._connect();
    }, delayMs);
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  private _teardownWs(): void {
    if (!this.ws) return;
    this.ws.removeEventListener('open',    this._onOpen);
    this.ws.removeEventListener('message', this._onMessage);
    this.ws.removeEventListener('close',   this._onClose);
    this.ws.removeEventListener('error',   this._onError);
    try {
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close(1000, 'leave');
      }
    } catch { /* ignore */ }
    this.ws = null;
  }

  // ── Public state accessors ────────────────────────────────────────────────

  /** Whether the initial Yjs sync handshake has completed on this connection. */
  get synced(): boolean { return this._synced; }

  /** Whether `leave()` has been called. */
  get closed(): boolean { return this._closed; }
}

// ─── PeerGridClient ───────────────────────────────────────────────────────────

/**
 * Main entry point for the PeerGrid SDK.
 *
 * One client instance can manage connections to multiple rooms simultaneously.
 * Each `joinRoom()` call opens a dedicated WebSocket connection.
 *
 * ```ts
 * const client = new PeerGridClient({
 *   url:   'wss://your-server.example.com/ws',
 *   token: 'your-jwt-access-token',
 * });
 *
 * const room = await client.joinRoom('doc123');
 * ```
 */
export class PeerGridClient {
  private readonly options: PeerGridClientOptions;
  private readonly rooms   = new Map<string, PeerGridRoom>();

  constructor(options: PeerGridClientOptions) {
    if (!options.routerUrl && !options.url) {
      throw new Error('PeerGridClient requires either routerUrl or url');
    }
    this.options = options;
  }

  private _routingEndpoint(roomId: string): string {
    if (!this.options.routerUrl) {
      throw new Error('routerUrl not configured');
    }
    return `${this.options.routerUrl.replace(/\/$/, '')}/route/room/${encodeURIComponent(roomId)}`;
  }

  private async _fetchRoomRoute(roomId: string): Promise<RouteResolution> {
    const endpoint = this._routingEndpoint(roomId);
    const timeoutMs = this.options.routing?.requestTimeoutMs ?? 3000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.options.token}`,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`routing request failed (${response.status})`);
      }

      const payload = await response.json() as Partial<RouteResolution>;
      if (payload.websocketUrl && typeof payload.websocketUrl === 'string') {
        return {
          roomId: payload.roomId ?? roomId,
          ownerNodeId: payload.ownerNodeId ?? null,
          ownerAddress: payload.ownerAddress ?? null,
          websocketUrl: payload.websocketUrl,
        };
      }

      throw new Error('routing response missing websocketUrl');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async _resolveWebsocketUrlWithRetry(roomId: string): Promise<string> {
    if (!this.options.routerUrl) {
      if (!this.options.url) throw new Error('No websocket URL configured');
      return this.options.url;
    }

    const maxAttempts = this.options.routing?.maxAttempts ?? 5;
    const baseDelayMs = this.options.routing?.baseDelayMs ?? 100;
    const maxDelayMs = this.options.routing?.maxDelayMs ?? 5000;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const route = await this._fetchRoomRoute(roomId);
        if (route.websocketUrl) return route.websocketUrl;
      } catch (err) {
        lastError = err;
      }

      const backoff = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const jitter = backoff * 0.2 * (Math.random() * 2 - 1);
      const delayMs = Math.max(0, Math.round(backoff + jitter));
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }

    if (this.options.url) {
      return this.options.url;
    }

    if (lastError instanceof Error) throw lastError;
    throw new Error('Failed to resolve room route');
  }

  /**
   * Join a collaborative room by file ID.
   *
   * Opens a WebSocket to the server, authenticates, and performs the Yjs sync
   * handshake.  Resolves when the room is **synced** (server has acknowledged
   * the client's state vector and delivered any outstanding document state).
   *
   * If the room is already open, the existing `PeerGridRoom` is returned
   * immediately (already synced or in-progress).
   *
   * @param fileId  The document / file ID to join.  Must correspond to a file
   *                the authenticated user has access to.
   * @returns       A fully-constructed `PeerGridRoom`.  The `room.doc` Y.Doc
   *                is ready to use once the returned promise resolves.
   */
  async joinRoom(fileId: string): Promise<PeerGridRoom> {
    const existing = this.rooms.get(fileId);
    if (existing && !existing.closed) return Promise.resolve(existing);

    const websocketUrl = await this._resolveWebsocketUrlWithRetry(fileId);

    const room = new PeerGridRoom(fileId, {
      token: this.options.token,
      websocketUrl,
      reconnect: this.options.reconnect,
      resolveWebsocketUrl: async (targetRoomId: string) => this._resolveWebsocketUrlWithRetry(targetRoomId),
    });
    this.rooms.set(fileId, room);

    room.on('close', () => {
      // Remove from tracking when permanently closed
      if (room.closed) this.rooms.delete(fileId);
    });

    room._connect();

    // Resolve once synced; reject on hard auth error before synced
    return await new Promise<PeerGridRoom>((resolve, reject) => {
      room.once('synced', () => resolve(room));
      room.once('error', (err) => {
        // Reject only on hard auth errors; transient routing/network issues
        // are handled by route + reconnect retries.
        if (
          !room.synced &&
          err instanceof Error &&
          err.message.startsWith('PeerGrid auth error')
        ) {
          reject(err);
        }
      });
    });
  }

  /**
   * Leave a specific room and clean up its resources.
   * Noop if the room was never joined or already left.
   */
  leaveRoom(fileId: string): void {
    const room = this.rooms.get(fileId);
    if (room) {
      room.leave();
      this.rooms.delete(fileId);
    }
  }

  /**
   * Leave all rooms and close all connections.
   */
  close(): void {
    for (const [fileId, room] of this.rooms) {
      room.leave();
      this.rooms.delete(fileId);
    }
  }

  /** IDs of rooms currently open on this client. */
  get openRoomIds(): string[] {
    return [...this.rooms.keys()];
  }

  /** Number of open rooms. */
  get roomCount(): number {
    return this.rooms.size;
  }
}
