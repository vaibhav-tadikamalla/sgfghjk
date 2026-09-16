/**
 * advancedMetrics.ts
 *
 * Advanced Prometheus metrics for production hardening.
 * Covers all 10 observability dimensions required for ≥98/100 audit:
 *
 *   1. CRDT merge latency (histogram)
 *   2. Redis propagation lag (histogram)
 *   3. WAL append latency (histogram)
 *   4. Snapshot compaction time (histogram)
 *   5. Per-room memory usage (gauge with fileId label)
 *   6. WebSocket bufferedAmount distribution (histogram)
 *   7. Backpressure events (counter)
 *   8. Room eviction events (counter)
 *   9. Byzantine payload rejections (counter)
 *  10. Redis partition / reconnect events (counter)
 *  11. Client ACK latency (histogram)
 *  12. State vector exchange events (counter)
 *
 * All metrics are registered on the shared PeerGrid registry so they appear
 * alongside the existing metrics at GET /metrics.
 */

import { Histogram, Counter, Gauge, Summary } from 'prom-client';
import { register } from './metrics';

// ── 1. CRDT merge latency ────────────────────────────────────────────────────

export const crdtMergeLatency = new Histogram({
  name: 'peergrid_crdt_merge_latency_ms',
  help: 'Time taken to apply a Yjs update via Y.applyUpdate (ms)',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100, 250],
  registers: [register],
});

// ── 2. Redis propagation lag ─────────────────────────────────────────────────

export const redisPropagationLag = new Histogram({
  name: 'peergrid_redis_propagation_lag_ms',
  help: 'End-to-end latency from Redis publish to local subscriber delivery (ms)',
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register],
});

// ── 3. WAL append latency ────────────────────────────────────────────────────

export const walAppendLatency = new Histogram({
  name: 'peergrid_wal_append_latency_ms',
  help: 'Time to INSERT a row into document_updates (ms)',
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500],
  registers: [register],
});

// ── 4. Snapshot compaction time ──────────────────────────────────────────────

export const snapshotCompactionDuration = new Histogram({
  name: 'peergrid_snapshot_compaction_duration_ms',
  help: 'Time spent compacting a Y.Doc snapshot (encoding + decoding + tombstone removal)',
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  registers: [register],
});

// ── 5. Per-room memory ──────────────────────────────────────────────────────

export const roomMemoryBytes = new Gauge({
  name: 'peergrid_room_memory_bytes',
  help: 'Estimated memory usage of a Y.Doc in bytes',
  labelNames: ['file_id'],
  registers: [register],
});

export const totalRoomMemoryBytes = new Gauge({
  name: 'peergrid_total_room_memory_bytes',
  help: 'Sum of all in-memory Y.Doc sizes across all rooms',
  registers: [register],
});

// ── 6. WebSocket bufferedAmount ──────────────────────────────────────────────

export const wsBufferedAmountBytes = new Histogram({
  name: 'peergrid_ws_buffered_amount_bytes',
  help: 'Distribution of WebSocket bufferedAmount values sampled during send',
  buckets: [0, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304],
  registers: [register],
});

// ── 7. Backpressure events ──────────────────────────────────────────────────

export const backpressureEventsCounter = new Counter({
  name: 'peergrid_backpressure_events_total',
  help: 'Total number of times a client was backpressured (paused or catch-up diffed)',
  labelNames: ['action'], // 'pause' | 'catchup' | 'drop'
  registers: [register],
});

// ── 8. Room eviction ────────────────────────────────────────────────────────

export const roomEvictionCounter = new Counter({
  name: 'peergrid_room_evictions_total',
  help: 'Total number of idle rooms evicted from memory by the LRU evictor',
  registers: [register],
});

export const roomEvictionDuration = new Histogram({
  name: 'peergrid_room_eviction_duration_ms',
  help: 'Time to serialize and evict an idle room from memory',
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
  registers: [register],
});

// ── 9. Byzantine payload rejections ─────────────────────────────────────────

export const byzantineRejectionsCounter = new Counter({
  name: 'peergrid_byzantine_rejections_total',
  help: 'Total number of CRDT updates rejected by byzantine payload validation',
  labelNames: ['reason'], // 'size_exceeded' | 'decode_failed' | 'crc_mismatch'
  registers: [register],
});

// ── 10. Redis partition / reconnect ──────────────────────────────────────────

export const redisPartitionCounter = new Counter({
  name: 'peergrid_redis_partitions_total',
  help: 'Total number of Redis disconnect events detected',
  registers: [register],
});

export const redisReconciliationCounter = new Counter({
  name: 'peergrid_redis_reconciliations_total',
  help: 'Total number of state vector reconciliation rounds after Redis reconnect',
  registers: [register],
});

export const redisReconciliationDuration = new Histogram({
  name: 'peergrid_redis_reconciliation_duration_ms',
  help: 'Time to complete a full state vector reconciliation round',
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [register],
});

// ── 11. Client ACK ──────────────────────────────────────────────────────────

export const clientAckLatency = new Histogram({
  name: 'peergrid_client_ack_latency_ms',
  help: 'Time from WAL append to ACK frame sent to client',
  buckets: [1, 2, 5, 10, 25, 50, 100],
  registers: [register],
});

// ── 12. State vector exchange ───────────────────────────────────────────────

export const stateVectorExchangeCounter = new Counter({
  name: 'peergrid_state_vector_exchanges_total',
  help: 'Total number of state vector exchanges during reconciliation',
  labelNames: ['direction'], // 'sent' | 'received'
  registers: [register],
});

// ── 13. Compaction stats ────────────────────────────────────────────────────

export const compactionTombstonesRemoved = new Counter({
  name: 'peergrid_compaction_tombstones_removed_total',
  help: 'Total number of tombstones removed during CRDT compaction',
  registers: [register],
});

export const compactionSavings = new Summary({
  name: 'peergrid_compaction_savings_ratio',
  help: 'Ratio of bytes saved by compaction (1.0 = 100% savings)',
  percentiles: [0.5, 0.9, 0.99],
  registers: [register],
});

// ── 14. Consistent hashing — topology ────────────────────────────────────────

export const topologyChangesCounter = new Counter({
  name: 'peergrid_topology_changes_total',
  help: 'Total number of cluster topology change events (node join/leave/crash)',
  labelNames: ['event_type'], // 'node_join' | 'node_leave' | 'node_crash'
  registers: [register],
});

export const ownershipTransfersCounter = new Counter({
  name: 'peergrid_ownership_transfers_total',
  help: 'Total number of room ownership transfers between nodes',
  registers: [register],
});

export const rebalanceDuration = new Histogram({
  name: 'peergrid_rebalance_duration_ms',
  help: 'Time to rebalance room ownership after a topology change',
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register],
});

export const clusterNodesGauge = new Gauge({
  name: 'peergrid_cluster_nodes',
  help: 'Number of active nodes in the PeerGrid cluster',
  registers: [register],
});

// ── 15. Redis Streams — event log ────────────────────────────────────────────

export const streamMessagesPublished = new Counter({
  name: 'peergrid_stream_messages_published_total',
  help: 'Total number of messages published to Redis Streams',
  registers: [register],
});

export const streamMessagesConsumed = new Counter({
  name: 'peergrid_stream_messages_consumed_total',
  help: 'Total number of messages consumed from Redis Streams',
  registers: [register],
});

export const streamConsumerLag = new Gauge({
  name: 'peergrid_stream_consumer_lag',
  help: 'Estimated consumer lag (pending entries) across all room streams',
  registers: [register],
});

export const streamReplayCounter = new Counter({
  name: 'peergrid_stream_replays_total',
  help: 'Total number of stream replay operations (pending entry recovery)',
  registers: [register],
});

// ── 16. Presence service ─────────────────────────────────────────────────────

export const presenceRateLimitDrops = new Counter({
  name: 'peergrid_presence_rate_limit_drops_total',
  help: 'Total number of presence updates dropped by rate limiting',
  registers: [register],
});

export const presenceActiveEntries = new Gauge({
  name: 'peergrid_presence_active_entries',
  help: 'Number of active presence entries across all rooms',
  registers: [register],
});

export const presenceViewportThrottleEvents = new Counter({
  name: 'peergrid_presence_viewport_throttle_total',
  help: 'Total number of presence updates throttled by viewport distance',
  labelNames: ['tier'], // 'MID' | 'FAR'
  registers: [register],
});

export const presencePublishLatency = new Histogram({
  name: 'peergrid_presence_publish_latency_ms',
  help: 'Time to publish a presence update to Redis',
  buckets: [0.5, 1, 2, 5, 10, 25, 50],
  registers: [register],
});

// ── 17. Stream idempotency ───────────────────────────────────────────────────

export const streamDuplicatesSkipped = new Counter({
  name: 'peergrid_stream_duplicates_skipped_total',
  help: 'Total number of duplicate stream entries skipped by the idempotency guard',
  registers: [register],
});

export const streamAutoclaimedEntries = new Counter({
  name: 'peergrid_stream_autoclaimed_entries_total',
  help: 'Total number of pending entries reclaimed via XAUTOCLAIM',
  registers: [register],
});

export const streamCheckpointFlushes = new Counter({
  name: 'peergrid_stream_checkpoint_flushes_total',
  help: 'Total number of HWM checkpoint flushes to Redis',
  registers: [register],
});

export const streamCheckpointLatency = new Histogram({
  name: 'peergrid_stream_checkpoint_latency_ms',
  help: 'Time to flush HWM checkpoints to Redis',
  buckets: [0.5, 1, 2, 5, 10, 25, 50],
  registers: [register],
});

export const streamIdempotencyGuardRooms = new Gauge({
  name: 'peergrid_stream_idempotency_tracked_rooms',
  help: 'Number of rooms currently tracked by the stream idempotency guard',
  registers: [register],
});

// ── 18. Cluster clock ────────────────────────────────────────────────────────

export const clusterClockDriftMs = new Gauge({
  name: 'peergrid_cluster_clock_drift_ms',
  help: 'Drift between Redis server time and local wall clock (ms). Positive = local clock is behind Redis.',
  registers: [register],
});

export const clusterClockRequestsTotal = new Counter({
  name: 'peergrid_cluster_clock_requests_total',
  help: 'Total number of Redis TIME sync requests (successful + failed)',
  labelNames: ['status'], // 'ok' | 'error'
  registers: [register],
});

export const clusterClockFallbackActive = new Gauge({
  name: 'peergrid_cluster_clock_fallback_active',
  help: '1 if the cluster clock is using monotonic fallback (Redis unavailable), 0 if synced',
  registers: [register],
});

// ── 19. Reconnect admission control ─────────────────────────────────────────

export const reconnectAttemptsTotal = new Counter({
  name: 'peergrid_reconnect_attempts_total',
  help: 'Total WebSocket connection attempts evaluated by the admission controller',
  registers: [register],
});

export const reconnectLimitedTotal = new Counter({
  name: 'peergrid_reconnect_limited_total',
  help: 'Total connections rejected or delayed by the reconnect admission controller',
  registers: [register],
});

export const reconnectQueueDepth = new Gauge({
  name: 'peergrid_reconnect_queue_depth',
  help: 'Current number of connections waiting for admission (told to retry)',
  registers: [register],
});

// ── 20. Edge CRDT read replicas ───────────────────────────────────────────

export const edgeMirrorDocsGauge = new Gauge({
  name: 'peergrid_edge_mirror_docs',
  help: 'Number of active edge mirror documents currently held in memory',
  registers: [register],
});

export const edgeMirrorUpdatesCounter = new Counter({
  name: 'peergrid_edge_mirror_updates',
  help: 'Total number of stream updates applied to edge mirror documents',
  registers: [register],
});

export const edgeMirrorLagMs = new Histogram({
  name: 'peergrid_edge_mirror_lag_ms',
  help: 'Lag between stream publish timestamp and local edge mirror application (ms)',
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register],
});

