# PeerGrid Scaling Proof

## 1) Heap Growth Model

Let:
- `D` = active loaded documents
- `I_d` = live CRDT struct count per document `d`
- `B_i` = average bytes per struct node in V8 object graph (item + references + content wrapper)
- `C` = active WebSocket connections
- `B_c` = average bytes per connection state (ws metadata + auth metadata + queue refs)

Approximate heap:

`Heap ~= sum_{d=1..D}(I_d * B_i) + C * B_c + RuntimeOverhead`

with:
- `B_i` typically in `[120, 300]` bytes depending on content shape and merge density,
- `B_c` typically `[2KB, 12KB]` depending on queue and awareness payload sizes.

Without compaction, deleted structures remain as tombstones and content can accumulate if GC packing is not forced.
With worker rebuild (`gc:true`) + pointer swap, deleted content collapses to compact delete metadata and old graph is reclaimed.

## 2) O(N) Encode Cost and CPU Bound

For a document with `N` structs:
- `Y.encodeStateAsUpdate(doc)` traverses struct store and delete set once: `O(N)`.
- SyncStep2 diff against state vector is `O(N)` worst-case (full scan + per-client lookups).

Per-update main-thread cost under steady state:

`T_update = T_decode + T_apply + T_broadcast + T_publish + T_authRevalidate`

where broadcast includes up to `(peers-1)` ws sends.

Throughput bound for single event loop:

`R_max <= 1 / T_update`

For stability, inbound rate must satisfy:

`R_in < R_max`

## 3) Throughput Math Under Given Load

Given:
- users = 50
- edits/sec/user = 7
- inbound updates/sec = `R_in = 350`
- fanout peers/edit = 49

WS send calls per second:

`S_ws = 350 * 49 = 17,150 sends/sec`

Assume average message payload `P=280` bytes (including framing and protocol overhead):

`BW_out ~= S_ws * P = 4,802,000 B/s ~= 4.58 MB/s ~= 36.6 Mbps`

Network is not dominant on 1GbE; CPU/event-loop scheduling is dominant.

If average per-update CPU on main thread is:
- warm cache path: `T_update=1.9ms` -> `R_max~526/s`, stable (`526>350`)
- cold permission path: `T_update=4.6ms` -> `R_max~217/s`, unstable (`217<350`)

Therefore permission cache hit-rate is a hard scaling lever.

## 4) Backpressure Inequality

Define:
- `λ = inbound updates/sec`
- `μ = drain capacity updates/sec`
- queue length `Q(t)`

Queue dynamics:

`dQ/dt = λ - μ`

Stability condition:

`μ > λ`

If `μ <= λ`, queue diverges and eventually triggers pressure controls:
- WS bufferedAmount growth,
- low-priority awareness drop,
- WAL buffer pressure (threshold guard),
- user-visible latency spikes.

PeerGrid controls:
- bounded Redis chunk ingest (50 messages/tick) with `setImmediate` yielding,
- low-priority awareness dropping when queue depth is high,
- max queue caps to avoid unbounded in-process growth.

## 5) GC Reclaim Explanation

### Pre-compaction
Live `Y.Doc` graph contains:
- struct arrays by client,
- doubly-linked item topology,
- deleted item metadata and potentially retained content.

### Post-compaction swap
1. worker returns compacted encoded state,
2. main thread constructs candidate `Y.Doc({gc:true})`,
3. candidate swaps into `managed.ydoc`,
4. old document listeners detached,
5. old `Y.Doc.destroy()` called.

After swap, old graph is unreachable from roots and reclaimed by V8 major GC cycle.
This bounds long-lived retention and prevents monotonic heap growth for actively edited docs.

## 6) Reconnect Storm Worst Case

Let:
- `K` reconnecting clients simultaneously on one hot document,
- `T_sync2(N)` = SyncStep2 generation time for document size `N`.

Without queueing:
- event-loop contiguous work `~K * T_sync2(N)`.

With queue limit `M` concurrent (where implemented):
- contiguous work per batch `~M * T_sync2(N)`,
- total completion `~ceil(K/M) * M * T_sync2(N)` but with inter-batch yields.

For `K=20`, `T_sync2=40ms`, `M=3`:
- no queue: `~800ms` contiguous risk,
- queued batches: `~120ms` chunks with scheduling gaps; lower timer starvation risk.

## 7) Memory Ceiling Proof (Operational)

Compaction threshold `T=5MB` encoded state/document.
For each loaded document `d`, persisted encoded size estimate `E_d` tracked by metric `document_size_bytes[d]`.
Compaction trigger invariant:

If `E_d >= T` and not compacting, compaction is scheduled.

Compaction completion updates `E_d <- E'_d` with expected `E'_d <= E_d` (strictly lower for delete-heavy history).
If transiently still above threshold, periodic retry loop re-triggers compaction.

Given retry interval `Δ=10s` and compaction duration upper bound `W`:
- a document can exceed `T` only for bounded windows of approximately `W + Δ + scheduling jitter` before another compaction attempt.

Hence persistent unbounded growth is prevented by:
1. threshold detection,
2. repeated compaction attempts,
3. explicit old-graph destruction,
4. idle unload after inactivity.

## 8) Burst Redis Ingress Stall Bound

Chunk size `B=50 messages/tick`.
Per-message parse+dispatch cost `c` (ms), worst-case chunk processing time:

`T_chunk = B * c`

To keep stalls under 200ms:

`B * c < 200ms`

With `B=50`, requirement is `c < 4ms/message`, which is satisfied for typical JSON decode + local fanout dispatch path.
If workload approaches this bound, additional controls are:
- lowering chunk size,
- reducing per-message payload,
- moving heavy decode work to worker threads.

## 9) Coordination Race Safety Summary

- Compaction lock quorum acquisition prevents dual-writer success path.
- Renewal every 5s against 15s TTL narrows lock-loss window.
- CAS on `compaction_version` prevents stale compactor commits.
- Buffered updates during compaction preserve in-flight edits.
- Post-CAS replay + dirty persist closes late-arrival window.

The combined lock+CAS+replay invariant guarantees no successful stale overwrite and no lost in-memory updates during swap.
