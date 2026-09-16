# PeerGrid Architecture

## 1) End-to-End Request Lifecycle

### 1.1 HTTP API path
1. Fastify accepts request on `0.0.0.0:${PORT}`.
2. Auth middleware records request timing.
3. Route handler executes domain logic (`auth`, `documents`, `assets`, `comments`, `snapshots`, `exports`).
4. PostgreSQL access goes through pooled `query()` with slow-query logging.
5. Optional Redis cache invalidation occurs via `CacheService`.
6. Response is emitted with security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Resource-Policy`).

### 1.2 WebSocket collaboration path
1. Upgrade request hits `/ws`; readiness gate rejects if startup barrier not met or node is draining.
2. Connection receives auth timeout guard (`AUTH_TIMEOUT_MS=5000`).
3. First client message must be JSON auth `{ type:'auth', accessToken, documentId, clientId }`.
4. JWT is verified (`RS256`, issuer/audience constrained) and revocation checked via Redis blacklist key.
5. Document authorization is validated from `document_permissions` + document existence check.
6. `DocumentManager.loadOrCreate()` loads state from PostgreSQL and materializes in-memory `Y.Doc`.
7. Server sends SyncStep1 and current awareness snapshot.
8. For each binary sync update:
   - permission is revalidated (revocation marker + cache + DB fallback),
   - `Y.applyUpdate()` mutates in-memory CRDT,
   - update broadcasts to local document peers,
   - update publishes to Redis channel `doc:{docId}` for cross-instance fanout.
9. Debounced persistence writes full encoded state to PostgreSQL and triggers compaction if threshold exceeded.

## 2) CRDT Wire Protocol

### 2.1 WebSocket message classes
- `MSG_SYNC=0` (binary): Yjs sync protocol
- `MSG_AWARENESS=1` (binary): awareness state updates
- JSON control messages: lock request/release/heartbeat

### 2.2 Sync payloads
- **SyncStep1**: `[varUint(MSG_SYNC), varUint(0), varUint8Array(stateVector)]`
- **SyncStep2**: `[varUint(MSG_SYNC), varUint(1), varUint8Array(diffUpdate)]`
- **Update**: `[varUint(MSG_SYNC), varUint(2), varUint8Array(update)]`

### 2.3 Awareness payload
- `[varUint(MSG_AWARENESS), varUint8Array(awarenessUpdate)]`
- Awareness update contains `(clientId, clock, stateJSON)` tuples.

### 2.4 Ordering and idempotence
- Redis Pub/Sub does not guarantee global total order across publishers.
- Yjs update application is commutative and idempotent by `(clientID, clock)` struct identity.
- Duplicate message arrival is safe; replay is safe.

## 3) Event Loop Phase Mapping

### Timers phase
- Document persist debounce callback (`setTimeout`, 5s)
- Document retry persist loop (`setInterval`, 10s)
- Idle cleanup (`setInterval`, 60s)
- Lock stale cleanup (`setInterval`, 15s)
- WebSocket ping (`setInterval`, 30s)
- Internal audit (`setInterval`, 60s)
- Compaction lock renewal (`setInterval`, 5s while compacting)

### Poll phase
- WebSocket `message`, `close`, `error`, `pong` handlers
- Redis subscriber `message` handler (ingress queue enqueue)
- Redis publish completion callbacks
- PostgreSQL query completion callbacks

### Check phase
- Chunked Redis ingress continuation via `setImmediate`
- Per tick max `50` Redis messages processed; remainder deferred to next check phase

### Close callbacks phase
- Socket close events, server close callback paths

### Event-loop safety controls
- Redis burst control: bounded queue processing (`<=50` messages/tick)
- Awareness low-priority drop on WS backpressure
- High/critical queue limits in backpressure manager
- Event loop P95 delay metric exported from `monitorEventLoopDelay`

## 4) Redis Coordination Model

### Channels
- `doc:{docId}`: CRDT update fanout between instances
- `revocation`: permission revocation fanout

### Local ingestion algorithm
1. Subscriber callback pushes `(channel,message)` into FIFO queue.
2. Scheduler processes max 50 items per tick.
3. If queue remains non-empty, `setImmediate` yields and resumes next chunk.
4. FIFO queue preserves receive-order for each connection stream.

### Locking model
- Compaction lock key: `lock:compact:{docId}`
- Adapter implements quorum-based Redlock semantics across configured Redis nodes (comma-separated URL list).
- Quorum = `floor(N/2)+1`.
- Acquire: parallel `SET key token PX ttl NX` on all nodes.
- Extend: Lua `PEXPIRE` if token matches, quorum required.
- Release: Lua `DEL` if token matches, quorum required.
- Renewal interval: 5s, TTL: 15s.

## 5) PostgreSQL Coordination and CAS

### State columns used by collaboration runtime
- `documents.ydoc_state BYTEA`
- `documents.compaction_version INTEGER`
- `documents.size_bytes INTEGER`
- `documents.wal_entries BYTEA[]` (schema-ready for WAL integration)

### Compaction CAS write
Compaction commit uses:
- `WHERE id=$docId AND compaction_version=$expected`
- `SET compaction_version=compaction_version+1`
- `RETURNING compaction_version`

This prevents stale worker outputs from overwriting newer compacted snapshots.

## 6) Compaction and Memory Bounding

### Trigger condition
- `WorkerCompactionAdapter.needsCompaction(sizeBytes)` with threshold 5MB.
- Triggered after persist and retried in background loop if still above threshold.

### Compaction execution
1. Acquire distributed lock (quorum).
2. Baseline snapshot: `Y.encodeStateAsUpdate(currentDoc)`.
3. Worker thread receives state as Transferable ArrayBuffer.
4. Worker rebuilds `new Y.Doc({ gc: true })`, applies baseline, re-encodes compacted state.
5. Main thread builds candidate doc from compacted state.
6. While worker runs, live inbound updates are buffered (`bufferedUpdates[]`).
7. Buffered updates are replayed onto candidate.
8. CAS persist compacted candidate state to PostgreSQL (`compaction_version` increment).
9. Atomic pointer swap on main thread in a single tick:
   - detach old update listener,
   - replace `managed.ydoc`,
   - attach new listener,
   - emit swap event for awareness rebind,
   - destroy old `Y.Doc`.
10. Any updates arriving after CAS but before swap are replayed and flagged dirty for follow-up persist.
11. Release lock.

### Swap safety
- No cross-thread mutable Y.Doc access (worker only sees encoded bytes).
- Main thread remains sole owner of live document object graph.

## 7) Failure Recovery

### Worker failure
- Worker timeout (120s) or crash aborts compaction.
- Document remains on existing live Y.Doc; normal persistence continues.

### Lock loss during compaction
- Renewal failure sets `lockLost=true`.
- Swap is skipped when lock is lost.
- No stale compacted state is installed.

### CAS conflict
- CAS miss indicates concurrent version advancement.
- Current compaction attempt aborts and retries later.

### Redis subscriber burst
- Queue absorbs burst; bounded chunking prevents long poll-phase monopolization.

### Redis disconnect
- Cross-instance fanout pauses; local collaboration still progresses in-memory.
- On reconnect, sync protocol converges state at connection/session boundaries.

## 8) Graceful Shutdown Ordering

Shutdown handlers are registered in reverse dependency order so execution (LIFO) is:
1. collaboration server close (stops inbound writes)
2. document manager shutdown (persists dirty docs, clears compaction timers)
3. event loop monitor stop
4. fastify close
5. database pool shutdown
6. redis shutdown

This preserves durability: persistence runs before DB teardown.

## 9) Horizontal Scaling Model

### Scale-out topology
- Multiple stateless Node.js instances behind LB.
- Shared PostgreSQL for durable snapshots.
- Shared Redis for cross-instance update fanout + lock quorum nodes.

### Consistency model
- Real-time convergence: CRDT merge + Redis fanout.
- Durable convergence: periodic full-state persist + compaction CAS.
- Locking scope: per-document compaction only (not per-edit).

### Scaling bottlenecks and controls
- SyncStep2 encode cost scales with document struct count.
- Burst controls: Redis chunking, websocket backpressure dropping low-priority presence updates.
- Memory controls: threshold-triggered compaction + idle document unload + explicit `Y.Doc.destroy()` on unload/swap.
