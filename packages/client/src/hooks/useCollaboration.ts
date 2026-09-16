import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { tokenManager } from '@/lib/auth/tokenManager';
import { wsUrl } from '@/lib/runtimeConfig';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

/** Maximum reconnect delay in milliseconds. */
const MAX_RECONNECT_DELAY_MS = 10_000;
/** Maximum consecutive reconnect attempts before backing off to max. */
const MAX_RETRY_COUNT = 20;

/* ── Logging helpers (structured, safe for production) ────────────────────── */

const LOG_PREFIX = '[PeerGrid:collab]';

function logInfo(msg: string, data?: Record<string, unknown>) {
  if (data) console.info(LOG_PREFIX, msg, data);
  else console.info(LOG_PREFIX, msg);
}

function logWarn(msg: string, data?: Record<string, unknown>) {
  if (data) console.warn(LOG_PREFIX, msg, data);
  else console.warn(LOG_PREFIX, msg);
}

function logError(msg: string, err?: unknown) {
  console.error(LOG_PREFIX, msg, err);
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface CollabUser {
  id: string;
  displayName: string;
  color: string;
}

interface UseCollaborationOptions {
  fileId: string | null;
  userName: string;
}

interface UseCollaborationReturn {
  ydoc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  status: ConnectionStatus;
  connectedUsers: CollabUser[];
  userColor: string;
  /** Server-sent permission error message, if any. Cleared on reconnect. */
  permissionError: string | null;
  disconnect: () => void;
}

/**
 * Try to send data on a WebSocket. Returns true on success.
 * Catches and logs send failures so they never crash the Yjs event loop.
 */
function safeSend(ws: WebSocket, data: Parameters<WebSocket['send']>[0], label: string): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(data);
    return true;
  } catch (err) {
    logWarn(`safeSend failed (${label})`, { readyState: ws.readyState });
    return false;
  }
}

export function useCollaboration({ fileId, userName }: UseCollaborationOptions): UseCollaborationReturn {
  const ydocRef = useRef(new Y.Doc());
  const awarenessRef = useRef(new awarenessProtocol.Awareness(ydocRef.current));
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [connectedUsers, setConnectedUsers] = useState<CollabUser[]>([]);
  const [userColor, setUserColor] = useState('#6366f1');
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const fileIdRef = useRef<string | null>(null);

  // ── Listener tracking refs ────────────────────────────────────────────────
  // These refs hold the currently-registered listener functions so we can
  // remove them cleanly before registering new ones (prevents accumulation).
  const onUpdateRef = useRef<((update: Uint8Array, origin: unknown) => void) | null>(null);
  const onAwarenessRef = useRef<((changes: { added: number[]; updated: number[]; removed: number[] }) => void) | null>(null);
  const onAwarenessUsersRef = useRef<(() => void) | null>(null);

  /**
   * Remove all Yjs/awareness listeners that were registered for the current
   * WebSocket session.  Safe to call even if no listeners are registered.
   */
  const removeDocListeners = useCallback(() => {
    const doc = ydocRef.current;
    const awareness = awarenessRef.current;

    if (onUpdateRef.current) {
      doc.off('update', onUpdateRef.current);
      onUpdateRef.current = null;
    }
    if (onAwarenessRef.current) {
      awareness.off('change', onAwarenessRef.current);
      onAwarenessRef.current = null;
    }
    if (onAwarenessUsersRef.current) {
      awareness.off('change', onAwarenessUsersRef.current);
      onAwarenessUsersRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }
    // Remove doc/awareness listeners BEFORE closing the WebSocket so no stale
    // closure can attempt to send on a closing socket.
    removeDocListeners();
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus('disconnected');
    setConnectedUsers([]);
  }, [removeDocListeners]);

  useEffect(() => {
    if (!fileId) {
      disconnect();
      return;
    }

    // If fileId changed mid-lifecycle (not initial mount), recreate doc + awareness.
    // On initial mount fileIdRef.current is null — skip destroy so the useRef doc
    // stays valid for the current render (TipTap's useEditor already captured it).
    if (fileIdRef.current !== fileId) {
      if (fileIdRef.current !== null) {
        removeDocListeners();
        ydocRef.current.destroy();
        ydocRef.current = new Y.Doc();
        awarenessRef.current = new awarenessProtocol.Awareness(ydocRef.current);
      }
      fileIdRef.current = fileId;
    }

    const doc = ydocRef.current;
    const awareness = awarenessRef.current;
    let authenticated = false;
    let retryCount = 0;
    let destroyed = false;

    const connect = async () => {
      if (destroyed) return;
      const token = await tokenManager.getValidToken();
      if (!token || destroyed) return;

      setStatus('connecting');
      setPermissionError(null);

      logInfo('connecting', { fileId, attempt: retryCount });

      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl('/ws'));
      } catch (err) {
        logError('WebSocket constructor failed', err);
        setStatus('error');
        return;
      }
      wsRef.current = ws;
      authenticated = false;

      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        logInfo('socket opened', { fileId });
        safeSend(ws, JSON.stringify({ type: 'auth', accessToken: token, fileId }), 'auth');
      };

      ws.onmessage = (event) => {
        // ── Pre-auth: expect JSON ───────────────────────────────────────
        if (!authenticated) {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'auth_success') {
              authenticated = true;
              setStatus('connected');
              setUserColor(msg.color || '#6366f1');
              retryCount = 0;

              logInfo('authenticated', { fileId, userId: msg.userId, role: msg.role });

              // Set local awareness
              awareness.setLocalStateField('user', {
                name: userName,
                color: msg.color || '#6366f1',
                userId: msg.userId,
              });

              // ── Remove any old listeners before registering new ones ──
              removeDocListeners();

              // Listen for doc updates → send to server
              const onUpdate = (update: Uint8Array, origin: unknown) => {
                if (origin === 'remote' || ws.readyState !== WebSocket.OPEN) return;
                try {
                  const encoder = encoding.createEncoder();
                  encoding.writeVarUint(encoder, MSG_SYNC);
                  syncProtocol.writeUpdate(encoder, update);
                  if (!safeSend(ws, encoding.toUint8Array(encoder), 'crdt-update')) {
                    logWarn('CRDT update not sent — socket not open', { fileId });
                  }
                } catch (err) {
                  logError('Failed to encode/send CRDT update', err);
                }
              };
              doc.on('update', onUpdate);
              onUpdateRef.current = onUpdate;

              // Listen for awareness updates → send to server
              const onAwareness = (changes: { added: number[]; updated: number[]; removed: number[] }) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                try {
                  const changedClients = [...changes.added, ...changes.updated, ...changes.removed];
                  const encoder = encoding.createEncoder();
                  encoding.writeVarUint(encoder, MSG_AWARENESS);
                  encoding.writeVarUint8Array(
                    encoder,
                    awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients),
                  );
                  safeSend(ws, encoding.toUint8Array(encoder), 'awareness');
                } catch (err) {
                  logError('Failed to encode/send awareness update', err);
                }
              };
              awareness.on('change', onAwareness);
              onAwarenessRef.current = onAwareness;

              // Send sync step 1
              try {
                const syncEncoder = encoding.createEncoder();
                encoding.writeVarUint(syncEncoder, MSG_SYNC);
                syncProtocol.writeSyncStep1(syncEncoder, doc);
                safeSend(ws, encoding.toUint8Array(syncEncoder), 'sync-step1');
              } catch (err) {
                logError('Failed to send sync step 1', err);
              }

              // Track user list from awareness
              const updateUsers = () => {
                const users: CollabUser[] = [];
                awareness.getStates().forEach((state) => {
                  if (state.user) {
                    users.push({
                      id: state.user.userId || 'unknown',
                      displayName: state.user.name || 'Unknown',
                      color: state.user.color || '#888',
                    });
                  }
                });
                setConnectedUsers(users);
              };
              awareness.on('change', updateUsers);
              onAwarenessUsersRef.current = updateUsers;
              updateUsers();

              return;
            }
            if (msg.type === 'auth_error') {
              logWarn('auth error from server', { reason: msg.reason, fileId });
              setStatus('error');
              ws.close();
              return;
            }
            // Handle user_joined / user_left during pre-auth race window
            if (msg.type === 'user_joined' || msg.type === 'user_left') {
              return;
            }
            // Handle retry_after (server overloaded)
            if (msg.type === 'retry_after') {
              logWarn('server requested retry', { retryAfterMs: msg.retryAfterMs });
              return;
            }
          } catch {
            // Not JSON — ignore during pre-auth
          }
          return;
        }

        // ── Post-auth: binary Yjs messages ──────────────────────────────
        if (event.data instanceof ArrayBuffer) {
          try {
            const data = new Uint8Array(event.data);
            if (data.byteLength === 0) return; // empty frame guard
            const decoder = decoding.createDecoder(data);
            const msgType = decoding.readVarUint(decoder);

            if (msgType === MSG_SYNC) {
              const encoder = encoding.createEncoder();
              encoding.writeVarUint(encoder, MSG_SYNC);
              const syncMsgType = syncProtocol.readSyncMessage(decoder, encoder, doc, 'remote');
              if (syncMsgType === 0) {
                // Response to sync step 1 → send sync step 2 to server
                if (encoding.length(encoder) > 1) {
                  safeSend(ws, encoding.toUint8Array(encoder), 'sync-step2');
                }
              }
            } else if (msgType === MSG_AWARENESS) {
              const update = decoding.readVarUint8Array(decoder);
              awarenessProtocol.applyAwarenessUpdate(awareness, update, 'remote');
            } else {
              // Unknown binary message type — log but do not crash
              logWarn('unknown binary message type', { msgType, fileId });
            }
          } catch (err) {
            logError('Failed to process binary message', err);
          }
          return;
        }

        // ── Post-auth: JSON control messages from server ────────────────
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            switch (msg.type) {
              case 'error':
                logWarn('server error', { message: msg.message, fileId });
                if (msg.message === 'Read-only access') {
                  setPermissionError(msg.message);
                }
                break;
              case 'user_joined':
                logInfo('user joined', { userId: msg.userId, displayName: msg.displayName });
                break;
              case 'user_left':
                logInfo('user left', { userId: msg.userId });
                break;
              case 'permission_revoked':
                logWarn('permission revoked by server', { fileId });
                setPermissionError('Your access has been revoked');
                break;
              default:
                logWarn('unhandled server JSON message', { type: msg.type });
            }
          } catch {
            logWarn('unparseable post-auth text message', { fileId });
          }
        }
      };

      ws.onclose = (ev) => {
        if (destroyed) return;
        logInfo('socket closed', { fileId, code: ev.code, reason: ev.reason, attempt: retryCount });
        // Remove listeners to prevent stale closures from firing on the dead ws
        removeDocListeners();
        setStatus('disconnected');
        authenticated = false;
        // Reconnect with exponential back-off (capped)
        if (retryCount < MAX_RETRY_COUNT) {
          retryCount++;
        }
        const delay = Math.min(1000 * Math.pow(2, retryCount), MAX_RECONNECT_DELAY_MS);
        logInfo('scheduling reconnect', { fileId, delayMs: delay, attempt: retryCount });
        reconnectTimerRef.current = setTimeout(() => void connect(), delay);
      };

      ws.onerror = (ev) => {
        logError('WebSocket error', ev);
        setStatus('error');
      };
    };

    void connect();

    return () => {
      destroyed = true;
      disconnect();
    };
  }, [fileId, userName, disconnect, removeDocListeners]);

  return {
    ydoc: ydocRef.current,
    awareness: awarenessRef.current,
    status,
    connectedUsers,
    userColor,
    permissionError,
    disconnect,
  };
}
