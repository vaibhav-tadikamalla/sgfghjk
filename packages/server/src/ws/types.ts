import type { WebSocket } from 'ws';
import type { Logger } from 'pino';

// ─── Permission roles ────────────────────────────────────────────────────────

export type WorkspaceRole = 'owner' | 'editor' | 'viewer';

// ─── WebSocket message-type constants ────────────────────────────────────────

/** Binary Yjs sync protocol message. */
export const MSG_SYNC = 0;
/** Binary Yjs awareness protocol message. */
export const MSG_AWARENESS = 1;
/** Client → server authentication frame. */
export const MSG_AUTH = 2;
/** Server → client ping (binary). */
export const MSG_PING = 3;
/** Client → server pong (binary). */
export const MSG_PONG = 4;
/**
 * Server → client acknowledgement frame.
 * Wire format: [MSG_ACK (varint 5)] [WAL sequence id (8 bytes big-endian uint64)]
 * Sent after a durable WAL append so the client can track persistence.
 */
export const MSG_ACK = 5;
/** State vector exchange for cross-node reconciliation (internal). */
export const MSG_SV_EXCHANGE = 6;

// ─── Timing constants ─────────────────────────────────────────────────────────

/** How often to send pings to connected clients (ms). */
export const PING_INTERVAL_MS = 30_000;
/** How long a new connection has to authenticate before being closed (ms). */
export const AUTH_TIMEOUT_MS = 10_000;
/** Idle timeout — connections not responding to pings are closed (ms). */
export const CONN_TIMEOUT_MS = PING_INTERVAL_MS * 2 + 5_000;
/** How often to flush in-memory edit counters to the database (ms). */
export const EDIT_FLUSH_INTERVAL_MS = 5_000;

// ─── Per-connection state ─────────────────────────────────────────────────────

/**
 * All mutable state associated with a single WebSocket connection.
 * Created when the socket is opened; removed from the room on disconnect.
 */
export interface ClientConnection {
  /** The underlying WebSocket socket. */
  ws: WebSocket;
  /** Unique ID for this connection (crypto.randomUUID()). */
  connectionId: string;
  /** Set to true once handleDisconnect has been called (guard against double-calls). */
  disconnected: boolean;
  /** True once an edit-session row has been created in the DB for this connection. */
  sessionStarted: boolean;
  /** Authenticated user ID (undefined until AUTH succeeds). */
  userId?: string;
  /** The file this connection is editing (undefined until AUTH succeeds). */
  fileId?: string;
  /** The user's permission level on this file (undefined until AUTH succeeds). */
  role?: WorkspaceRole;
  /** Display name resolved from the JWT / user record. */
  displayName?: string;
  /** User email. */
  email?: string;
  /** The workspace (folder) this file belongs to — resolved after auth. */
  workspaceId?: string;
  /** Cursor colour assigned by the server. */
  color: string;
  /** Unix timestamp (ms) when the WebSocket was accepted. */
  joinedAt: number;
  /** Unix timestamp (ms) of the last pong / data frame received. */
  lastPing: number;
  /** Handle of the pending auth-timeout timer (cleared once AUTH is received). */
  authTimeout?: ReturnType<typeof setTimeout>;
  /**
   * The Yjs awareness clientID advertised by this connection.
   * Extracted from the first awareness update sent by the client.
   * Used to remove the correct awareness state on disconnect.
   */
  awarenessClientId?: number;
  /** Correlation ID propagated from the HTTP upgrade request (x-trace-id header). */
  traceId: string;
  /** Pino child logger pre-bound with connectionId + traceId. */
  log: Logger;
  /** Backpressure tracking state for this connection. */
  backpressure?: import('./backpressure').BackpressureState;
  /** True when this connection is attached to a non-owner edge mirror room. */
  servedByMirror?: boolean;
}
