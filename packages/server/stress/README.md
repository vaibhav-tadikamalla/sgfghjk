# PeerGrid WebSocket Stress Test Harness

External stress test for the real-time collaboration backend.
Does **not** modify any production source code.

---

## Prerequisites

1. PostgreSQL running on port 5433 (Docker):
   ```
   docker compose up -d
   ```

2. Server built and running in production mode on port 4850:
   ```
   cd packages/server
   pnpm build
   node dist/index.js
   ```
   or
   ```
   pnpm --filter server start
   ```

3. No prior `stress_*` users in the database (or the test will skip failed registrations
   and continue with fewer users — it will log warnings but not fail hard).

---

## How to Run

From the **monorepo root**:

```bash
# Run all four scenarios sequentially
node packages/server/stress/stress.mjs

# Run a single scenario
node packages/server/stress/stress.mjs 1
node packages/server/stress/stress.mjs 2
node packages/server/stress/stress.mjs 3
node packages/server/stress/stress.mjs 4
```

The script uses the `ws` package already present in `packages/server/node_modules`.
No additional install step is required.

---

## Setup Phase

Before any scenario runs, the harness:

1. Registers **1 owner** account (`stress_<ts>_owner@stress.test`).
2. Creates a **folder** and a single **file** owned by that account.
3. Registers **40 editor accounts** and invites each to the folder.

All accounts use email addresses prefixed with the current Unix timestamp
(`stress_<ts>_…`) so multiple consecutive runs do not collide.

Total accounts created per run: **41** (1 owner + 40 editors).

---

## Scenarios

### Scenario 1 — Concurrent Editors (60 s)

| Setting | Value |
|---|---|
| Simultaneous connections | 50 |
| Accounts used | 10 (5 connections each, respecting Guard 2) |
| Update interval per client | 50 – 150 ms random |
| Duration | 60 s |

Each client authenticates, sends a Yjs sync-step-1 to join the session,
then streams no-op Yjs update frames at random intervals.

**What to watch:**
- `Errors` and `Unexpected closes` should be near zero.
- `Messages sent` should be ~20 000 – 60 000.
- Server should remain responsive (check with `curl http://localhost:4850/health`).

---

### Scenario 2 — Connect/Disconnect Storm (60 s)

| Setting | Value |
|---|---|
| Concurrent connections per wave | 40 |
| Edit time per client | 3 s |
| Duration | 60 s |

Clients connect, edit, disconnect in rapid waves for 60 seconds.
Tests `handleDisconnect` cleanup, room lifecycle (create/destroy), DB flush on last disconnect,
and `userConnectionCounts` accuracy under churn.

**What to watch:**
- `Disconnects` should match `Auth successes` (every connect has a clean disconnect).
- `Unexpected closes` should be 0.
- Server heap should not grow monotonically (no memory leak).

---

### Scenario 3 — Burst Flood Attempt

| Setting | Value |
|---|---|
| Frames in burst | 200 (in < 1 s) |
| Server throttle limit | 50/s per connection |
| Observer clients | 1 |

A single "attacker" client fires 200 Yjs update frames as fast as possible.
An "observer" client is connected to the same file concurrently.

**Expected outcome:**
- Server drops frames 51–200 silently (Guard 3 burst throttle).
- Attacker may or may not be disconnected — the throttle does not close the socket.
- Observer MUST remain connected and unaffected.
- `[S3] ✅ PASS — observer unaffected` should appear in output.

**What a failure looks like:**
- `[S3] ❌ FAIL — observer was disconnected` → Guard 3 is leaking state across connections.
- Server process crash → burst flood caused an unhandled rejection.

---

### Scenario 4 — Large Document Editing (60 s)

| Setting | Value |
|---|---|
| Simultaneous connections | 10 |
| Update interval | 80 ms per client |
| Full sync-step-1 every | 5 s per client |
| Duration | 60 s |

Tests sustained memory pressure. Each client periodically sends a `syncStep1`
request, which causes the server to re-encode its full Yjs document state
into a `syncStep2` reply. This exercises the `Y.encodeStateAsUpdate()` path
and the awareness snapshot builder under concurrent load.

**What to watch:**
- Heap should be stable (not growing >10 MB over the run).
- `Messages received` should be high (server is sending syncStep2 responses).
- `Unexpected closes` should be 0.

---

## Output Format

Every 5 seconds each scenario prints a memory/CPU snapshot:

```
[S1] heap=45.2 MB  rss=88.0 MB  sys-free=3204 MB  cpu-cores=8
```

At the end of each scenario a result table is printed:

```
┌─ Scenario 1 — Concurrent Editors ─── 61.4s ─────────────────────┐
│  Messages sent        : 32847
│  Messages received    : 194502
│  Auth successes       : 50
│  Auth failures        : 0
│  Errors               : 0
│  Disconnects          : 50
│  Unexpected closes    : 0
│  Heap used            : 52.1 MB
│  RSS                  : 94.6 MB
└──────────────────────────────────────────────────────────────────┘
```

---

## Yjs Frame Protocol Notes

The harness constructs valid binary WebSocket frames:

| Frame | Bytes (hex) | Purpose |
|---|---|---|
| `SYNC_STEP1_FRAME` | `00 00 00` | MSG_SYNC + syncStep1 + empty state vector |
| `NOOP_UPDATE_FRAME` | `00 02 02 00 00` | MSG_SYNC + msgYjsUpdate + 2-byte no-op update |

A no-op Yjs v1 update (`0x00 0x00`) decodes as:
- `varint(0)` — zero struct entries
- `varint(0)` — empty delete set

`Y.applyUpdate` accepts this silently with no document mutation.

---

## Cleanup

Test accounts and workspace data remain in the database after the run
(prefixed with `stress_<timestamp>_`).

To clean up manually:

```sql
DELETE FROM users WHERE email LIKE 'stress_%@stress.test';
```

(Folder and files are cascade-deleted when the owner user row is removed,
depending on your FK constraints.)
