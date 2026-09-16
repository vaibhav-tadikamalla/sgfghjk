# PeerGrid Production Hardening Report

**Date:** June 2025  
**Scope:** Full-stack audit and hardening of the PeerGrid distributed collaboration platform  
**Constraint:** No architecture rewrites — harden the existing system

---

## 1. Executive Summary

Comprehensive production hardening pass across 6 critical files, addressing **12 distinct vulnerability categories** spanning client resilience, server safety, resource lifecycle, and distributed coordination. All changes compile cleanly (`tsc + esbuild` for server, `tsc + vite` for client) and pass **82 tests** including 21 newly created failure scenario tests.

---

## 2. Files Modified

| File | Changes | Category |
|------|---------|----------|
| `packages/client/src/hooks/useCollaboration.ts` | Complete rewrite (239 → 398 lines) | Client resilience |
| `packages/client/src/features/workspace/FileEditor.tsx` | 2 edits | Permission UX |
| `packages/server/src/ws/Room.ts` | 3 edits | CRDT safety |
| `packages/server/src/websocket.ts` | 3 edits | Server resilience |
| `packages/server/src/ws/EdgeMirrorManager.ts` | 1 edit | Edge mirror safety |
| `packages/tests/unit/failure-scenarios.test.ts` | New file (21 tests) | Validation |

---

## 3. Vulnerabilities Discovered and Fixed

### 3.1 Client: Listener Leak on Reconnect (CRITICAL)
**Problem:** `doc.on('update')` was never removed before registering a new listener on reconnect. Each reconnect accumulated another listener, causing:
- Exponentially increasing CPU usage per keystroke
- Duplicate `ws.send()` calls per update (N listeners → N sends)
- Memory leak from stale closures holding old WebSocket refs

**Fix:** Added `onUpdateRef`, `onAwarenessRef`, `onAwarenessUsersRef` tracking refs. New `removeDocListeners()` function called:
- Before registering new listeners
- In `ws.onclose`
- Before `ydoc.destroy()` on file switch

### 3.2 Client: Unguarded ws.send() (CRITICAL)
**Problem:** All `ws.send()` calls were unguarded. A `send()` throwing inside a Yjs `doc.on('update')` handler would crash the entire Yjs event emitter loop, silently breaking all future sync.

**Fix:** Created `safeSend(ws, data, label)` helper wrapping every send in try/catch with structured logging. All 4 send sites now use it.

### 3.3 Client: Silent Post-Auth JSON Message Drop (HIGH)
**Problem:** After authentication, the client only handled binary (CRDT) frames. JSON text frames from the server (errors, permission changes, user join/leave) were silently discarded.

**Fix:** Added post-auth JSON message handler with `switch(msg.type)` covering:
- `error` → sets `permissionError` state (including 'Read-only access')
- `user_joined` / `user_left` → logged
- `permission_revoked` → sets permission error, triggers disconnect
- `retry_after` → respects server overload backoff
- Unknown types → logged as warnings

### 3.4 Client: No Permission Error Display (HIGH)
**Problem:** Server-side permission rejections had no UI visibility. Users could lose write access mid-session with no feedback.

**Fix:** Added `permissionError` state to `useCollaboration`. Added red error banner in `FileEditor.tsx` between toolbar and editor content.

### 3.5 Server: Room.applyClientUpdate Crash on Bad Update (HIGH)
**Problem:** `Y.applyUpdate()` in `applyClientUpdate()` could throw on malformed CRDT payloads. The exception would propagate uncaught through the broadcast path, potentially crashing the room.

**Fix:** Wrapped `Y.applyUpdate()` in try/catch — increments `byzantineRejectionsCounter({ reason: 'apply_update_failed' })` and re-throws for caller handling. Separated broadcast encoding into its own try/catch so broadcast failure never rolls back a successfully applied update.

### 3.6 Server: Room.applyRemoteUpdate Crash Risk (HIGH)
**Problem:** Same pattern as 3.5 but for updates arriving via Redis Streams. A crash here would kill the stream consumer loop.

**Fix:** Separate try/catch for `Y.applyUpdate()` (re-throws with `remote_apply_failed` counter) and for broadcast encoding (silently caught — must never crash stream consumer).

### 3.7 Server: broadcastBinary sendCatchupDiff Unguarded (MEDIUM)
**Problem:** `sendCatchupDiff()` could throw unexpected errors that weren't caught by the outer broadcast loop, potentially terminating mid-iteration.

**Fix:** Wrapped `sendCatchupDiff()` call in try/catch guard.

### 3.8 Server: handleDataMessage Processing After Disconnect (MEDIUM)
**Problem:** A queued `message` event could fire after `conn.disconnected` was set by an error/close handler, causing operations on a torn-down connection.

**Fix:** Added `if (conn.disconnected) return;` guard at the top of `handleDataMessage`.

### 3.9 Server: Silent Send Failures in Helpers (LOW)
**Problem:** `sendJson()` and `sendBinary()` silently swallowed all errors with empty catch blocks, making post-mortem debugging difficult.

**Fix:** Added `conn.log.debug()` logging in catch blocks with error context (message type for JSON, byte length for binary).

### 3.10 Server: closeRoomsForFolder Resource Leak (MEDIUM)
**Problem:** When a folder was deleted, `closeRoomsForFolder()`:
- Did not drain pending edit counts → edit statistics lost
- Did not end active edit sessions → session records left in "active" state
- Did not clean up LRU/compaction tracking → stale entries

**Fix:** Added `room.drainPendingEdits()` + `flushUserEdits()` (fire-and-forget), `persistence.endSession()` for each active connection, and `roomLru.remove()` + `clearCompactionState()`.

### 3.11 Server: EdgeMirrorManager.applyStreamUpdate Unguarded (MEDIUM)
**Problem:** `applyStreamUpdate()` called `room.applyRemoteUpdate()` without try/catch. A single bad update from the stream could crash the mirror manager's callback chain.

**Fix:** Wrapped in try/catch with contextual logging (fileId, update byte length). Failed updates are dropped without updating timestamps.

### 3.12 Client: Empty Frame Guard (LOW)
**Problem:** A zero-length binary frame would cause the decoder to throw when reading the message type varint.

**Fix:** Added `data.byteLength === 0` guard before binary message processing.

---

## 4. Components Audited — No Changes Required

| Component | Lines | Assessment |
|-----------|-------|------------|
| `RedisRoomStore.ts` | 1,106 | Extensively guarded. Every Redis operation has `.catch()`. Stream consumer has per-entry try/catch. Forward writes have timeouts. Reconnect triggers reconciliation. Presence updates are rate-limited. Lock acquisition uses exponential backoff with Lua-script ownership verification. |
| `redisStreams.ts` | 761 | StreamConsumerLoop has comprehensive error handling: per-room try/catch in `pollRoom`, per-entry try/catch in processing, idempotency guard prevents duplicates, `autoclaimAll` has per-room try/catch. |
| `ConnectionGuards.ts` | — | Edit burst throttle, message size cap, session limit, UUID validation — all functioning correctly. |
| `backpressure.ts` | — | High-water mark detection with catch-up diff mechanism works as designed. |
| `byzantineGuard.ts` | — | CRDT payload validation (max size, struct count limits) operating correctly. |

---

## 5. Test Coverage Added

**New file:** `packages/tests/unit/failure-scenarios.test.ts` — 21 tests across 8 failure categories:

| Category | Tests | What's Validated |
|----------|-------|------------------|
| Malformed CRDT Updates | 4 | Garbage bytes, truncated updates, zero-length, repeated bombardment |
| Broadcast During Update | 2 | Update applies despite broadcast failure, 3-node convergence after partial failure |
| Listener Accumulation | 2 | doc.on handler cleanup, awareness listener cleanup |
| Permission Revocation | 2 | Update frame identification for Guard 7, server doc preservation |
| Empty/Oversized Frames | 2 | Empty decoder handling, single-byte frame |
| State Vector Recovery | 3 | One-sided partition, bidirectional partition, idempotent application |
| Backpressure Catch-up | 2 | Full catch-up diff, partial sync without duplication |
| Rapid Edit Storm | 2 | 100 concurrent edits convergence, out-of-order convergence |
| Y.Doc Destroy Safety | 2 | Post-destroy mutation safety, awareness destroy safety |

---

## 6. Build Verification

| Package | Command | Result |
|---------|---------|--------|
| Server | `pnpm --filter server build` | ✅ `tsc` + esbuild → `dist/index.js` (284.5kb) |
| Client | `pnpm --filter client build` | ✅ `tsc` + vite → 9 chunks, 883 modules |
| Tests | `npx vitest run` | ✅ 82 passed, 0 failed, 1 skipped (fuzz) |

---

## 7. Remaining Risks and Recommendations

### Residual Risk: MEDIUM
| Risk | Severity | Mitigation |
|------|----------|------------|
| Redis total failure (no pub/sub, no streams) | Medium | Existing: circuit breaker reopens after cooldown. Rooms degrade to single-node mode. Reconciliation triggers on reconnect. |
| PostgreSQL WAL append failure | Medium | Existing: update is dropped to preserve durability ordering. Client can retry. WAL latency is instrumented. |
| Mobile browser WebSocket termination by OS | Low | Fixed: `safeSend` + reconnect with exponential backoff + retry count cap. Client shows disconnected state. |
| Y.Doc memory growth (no compaction) | Low | Existing: compaction sweep runs periodically, LRU eviction bounds total rooms. |
| Stale awareness cursors after network glitch | Low | Existing: awareness states removed on disconnect. Client re-sends awareness on reconnect. |

### Monitoring Recommendations
1. **Alert on `byzantine_rejections_total{reason="apply_update_failed"}` > 0** — indicates clients sending corrupt CRDT data
2. **Alert on `crdt_merge_latency_seconds` p99 > 100ms** — indicates Y.Doc growing too large
3. **Dashboard on `ws_messages_sent_total` vs `ws_messages_received_total` ratio** — should be ~1:1 for sync health
4. **Alert on `edge_mirror_lag_ms` p99 > 5000ms** — stream replication falling behind
5. **Log grep for `safeSend failed`** — indicates connection instability patterns

---

## 8. Architecture Integrity

No architectural changes were made. All modifications are:
- **Additive guards** (try/catch, null checks, state guards)
- **Lifecycle correctness** (listener cleanup, resource drain)
- **Observability improvements** (structured logging, error context)

The existing 7-guard chain in `handleDataMessage`, the WAL-first durability ordering, the Redis Streams consumer with idempotency guard, and the consistent-hash room ownership model remain unchanged.
