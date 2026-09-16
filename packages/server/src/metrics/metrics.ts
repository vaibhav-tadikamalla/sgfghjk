/**
 * metrics.ts
 *
 * Central Prometheus metrics registry for PeerGrid.
 *
 * All metrics are registered on a single non-default Registry so the server
 * controls exactly what is exported.  Node.js default metrics (GC, memory,
 * event-loop, …) are collected via collectDefaultMetrics().
 *
 * This module is a pure singleton — safe to import from anywhere without
 * risk of double-registration.
 */

import {
  Registry,
  collectDefaultMetrics,
  Gauge,
  Counter,
} from 'prom-client';

// ── Shared registry ───────────────────────────────────────────────────────────

export const register = new Registry();
register.setDefaultLabels({ app: 'peergrid' });
collectDefaultMetrics({ register });

// ── Active rooms ──────────────────────────────────────────────────────────────

export const activeRoomsGauge = new Gauge({
  name: 'peergrid_active_rooms',
  help: 'Number of Yjs collaboration rooms currently held in memory',
  registers: [register],
});

// ── Active WebSocket sessions ─────────────────────────────────────────────────

export const activeSessionsGauge = new Gauge({
  name: 'peergrid_active_sessions',
  help: 'Number of authenticated WebSocket connections currently open',
  registers: [register],
});

// ── WebSocket message counters ────────────────────────────────────────────────

export const wsMessagesSentCounter = new Counter({
  name: 'peergrid_ws_messages_sent_total',
  help: 'Total number of WebSocket messages (binary and JSON) sent to clients',
  registers: [register],
});

export const wsMessagesReceivedCounter = new Counter({
  name: 'peergrid_ws_messages_received_total',
  help: 'Total number of WebSocket messages received from clients',
  registers: [register],
});

// ── Snapshot queue gauge ──────────────────────────────────────────────────────

export const snapshotQueueSizeGauge = new Gauge({
  name: 'peergrid_snapshot_queue_size',
  help: 'Number of snapshot write jobs currently pending in the coalescing queue',
  registers: [register],
});

// ── Snapshot write counter ────────────────────────────────────────────────────

export const snapshotWritesTotalCounter = new Counter({
  name: 'peergrid_snapshot_writes_total',
  help: 'Total number of CRDT snapshots successfully written to PostgreSQL',
  registers: [register],
});

// ── Event-loop lag ────────────────────────────────────────────────────────────

export const eventLoopLagGauge = new Gauge({
  name: 'peergrid_event_loop_lag_ms',
  help: 'Sampled event-loop lag in milliseconds (measured via setInterval + hrtime)',
  registers: [register],
});

// ── Room lifecycle counters ─────────────────────────────────────────────────

export const roomsCreatedCounter = new Counter({
  name: 'peergrid_rooms_created_total',
  help: 'Total number of Room instances constructed since process start',
  registers: [register],
});

export const roomsDestroyedCounter = new Counter({
  name: 'peergrid_rooms_destroyed_total',
  help: 'Total number of Room instances destroyed since process start',
  registers: [register],
});

export const roomsByStateGauge = new Gauge({
  name: 'peergrid_rooms_by_state',
  help: 'Number of rooms currently in each lifecycle state',
  labelNames: ['state'],
  registers: [register],
});

// ── Redis coordination metrics ────────────────────────────────────────────────

// ── PeerGrid observability counters ─────────────────────────────────────────

export const updatesAppliedCounter = new Counter({
  name: 'peergrid_updates_applied_total',
  help: 'Total number of CRDT updates applied (client + remote)',
  registers: [register],
});

export const updatesBroadcastCounter = new Counter({
  name: 'peergrid_updates_broadcast_total',
  help: 'Total number of broadcast rounds executed across all rooms',
  registers: [register],
});

export const connectionsOpenedCounter = new Counter({
  name: 'peergrid_connections_opened_total',
  help: 'Total number of WebSocket connections opened since process start',
  registers: [register],
});

export const connectionsClosedCounter = new Counter({
  name: 'peergrid_connections_closed_total',
  help: 'Total number of WebSocket connections closed since process start',
  registers: [register],
});

// ── Redis coordination metrics (existing) ─────────────────────────────────────

export const redisPubsubMessagesCounter = new Counter({
  name: 'peergrid_redis_pubsub_messages_total',
  help: 'Total number of Redis Pub/Sub messages received, partitioned by channel prefix',
  labelNames: ['channel'],
  registers: [register],
});

export const roomLockContentionCounter = new Counter({
  name: 'peergrid_room_lock_contention_total',
  help: 'Total number of times a room creation lock was already held by another node',
  registers: [register],
});

export const roomsOwnedGauge = new Gauge({
  name: 'peergrid_rooms_owned',
  help: 'Number of rooms for which this node holds the Redis ownership key',
  registers: [register],
});

// ── Event-loop lag ────────────────────────────────────────────────────────────

// Sample every 500 ms.  We schedule a callback with a 500 ms target delay
// and measure actual elapsed wall-clock time; the difference is the lag.
(function sampleEventLoopLag() {
  const SAMPLE_MS = 500;
  const SAMPLE_NS = BigInt(SAMPLE_MS) * 1_000_000n;
  let prev = process.hrtime.bigint();
  setInterval(() => {
    const now = process.hrtime.bigint();
    // Compare against the EXPECTED tick time so drift does not accumulate
    // across consecutive samples (expected = prev + SAMPLE_NS).
    const lagMs = Math.max(0, Number(now - prev - SAMPLE_NS) / 1_000_000);
    eventLoopLagGauge.set(lagMs);
    prev = now;
  }, SAMPLE_MS).unref(); // unref so this timer never keeps the process alive alone
})();
