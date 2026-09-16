/**
 * consistentHash.ts
 *
 * Consistent hashing with virtual nodes for deterministic room ownership.
 *
 * Problem:
 *   In a multi-node PeerGrid cluster, Redis pub/sub scales poorly when every
 *   node subscribes to every room's channels.  We need deterministic ownership
 *   so that only ONE node hosts the canonical Y.Doc for each room, and non-owner
 *   nodes proxy updates to the owner.
 *
 * Solution:
 *   A consistent hash ring maps room IDs to owner nodes using virtual nodes
 *   (vnodes) to ensure even distribution.  The ring is built from the set of
 *   registered nodes and can be updated as nodes join/leave.
 *
 * Design:
 *   - Uses CRC32 hashing (fast, deterministic, no crypto overhead)
 *   - 150 virtual nodes per physical node for even distribution
 *   - Ring is a sorted array of { hash, nodeId } entries
 *   - Lookup is O(log N) binary search
 *   - Rebalancing computes ownership diff and returns transfer instructions
 *
 * Redis key structure:
 *   - `pg:nodes`                        → Redis SET of active node IDs
 *   - `pg:node:<nodeId>:heartbeat`      → STRING with EX 15s (liveness TTL)
 *   - `pg:room:<roomId>:owner`          → STRING nodeId with EX 30s (ownership claim)
 *   - `pg:node:<nodeId>:rooms`          → SET of room IDs owned by this node
 *
 * Ownership transfer protocol:
 *   1. Node joins → registers in `pg:nodes` + heartbeat key
 *   2. All nodes rebuild the hash ring from `pg:nodes`
 *   3. Compute ownership diff: rooms whose ideal owner changed
 *   4. Old owner snapshots Y.Doc state → PostgreSQL
 *   5. Old owner publishes `ownership_transfer:<roomId>` with state metadata
 *   6. New owner loads from PostgreSQL and takes over
 *   7. No updates lost: WAL captures everything, new owner replays from WAL
 */

import { createHash } from 'node:crypto';
import { getLogger } from '../utils/logger';
import { getClusterTimeMs } from './clusterClock';

// ── CRC32 (fast deterministic hash) ─────────────────────────────────────────

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) {
    crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  CRC32_TABLE[i] = crc;
}

function crc32(data: string): number {
  const bytes = Buffer.from(data, 'utf8');
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]!) & 0xFF]!;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface VNode {
  /** CRC32 hash positioned on the ring. */
  hash: number;
  /** Physical node ID this vnode belongs to. */
  nodeId: string;
}

export interface OwnershipTransfer {
  roomId: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface RebalanceResult {
  /** Rooms that must be transferred between nodes. */
  transfers: OwnershipTransfer[];
  /** Map of roomId → new owner nodeId after rebalance. */
  newOwnership: Map<string, string>;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Number of virtual nodes per physical node on the hash ring. */
export const VNODES_PER_NODE = 150;

/** TTL for node heartbeat key in Redis (seconds). */
export const NODE_HEARTBEAT_TTL_SEC = 15;

/** How often to refresh the heartbeat (ms). */
export const NODE_HEARTBEAT_INTERVAL_MS = 5_000;

/** TTL for room ownership claim in Redis (seconds). */
export const ROOM_OWNERSHIP_TTL_SEC = 30;

/** How often to refresh room ownership claims (ms). */
export const ROOM_OWNERSHIP_REFRESH_MS = 10_000;

// ── Redis key helpers ───────────────────────────────────────────────────────

/** Redis SET of all active node IDs in the cluster. */
export function nodeRegistryKey(): string {
  return 'pg:nodes';
}

/** Per-node heartbeat key — expires if node dies. */
export function nodeHeartbeatKey(nodeId: string): string {
  return `pg:node:${nodeId}:heartbeat`;
}

/** Per-room ownership claim — stores the owning nodeId. */
export function roomOwnershipKey(roomId: string): string {
  return `pg:room:${roomId}:owner`;
}

/** Per-node set of owned rooms. */
export function nodeRoomsKey(nodeId: string): string {
  return `pg:node:${nodeId}:rooms`;
}

/** Per-node websocket public address metadata (used by room-affinity routing). */
export function nodeAddressKey(nodeId: string): string {
  return `pg:node:${nodeId}:address`;
}

/** Pub/Sub channel for cluster topology changes. */
export const TOPOLOGY_CHANGE_CHANNEL = 'pg:topology:change';

/** Pub/Sub channel for ownership transfer messages. */
export function ownershipTransferChannel(roomId: string): string {
  return `pg:ownership:transfer:${roomId}`;
}

// ── ConsistentHashRing ──────────────────────────────────────────────────────

/**
 * Consistent hash ring with virtual nodes.
 *
 * Provides deterministic mapping from room IDs to node IDs with minimal
 * redistribution when nodes are added or removed.
 */
export class ConsistentHashRing {
  /** Sorted array of virtual nodes. */
  private ring: VNode[] = [];
  /** Set of physical node IDs on the ring. */
  private readonly nodes = new Set<string>();

  constructor(nodeIds?: string[]) {
    if (nodeIds) {
      for (const id of nodeIds) this.addNode(id);
    }
  }

  /** Add a physical node to the ring with VNODES_PER_NODE virtual nodes. */
  addNode(nodeId: string): void {
    if (this.nodes.has(nodeId)) return;
    this.nodes.add(nodeId);
    for (let i = 0; i < VNODES_PER_NODE; i++) {
      this.ring.push({
        hash: crc32(`${nodeId}#${i}`),
        nodeId,
      });
    }
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  /** Remove a physical node and all its virtual nodes from the ring. */
  removeNode(nodeId: string): void {
    if (!this.nodes.has(nodeId)) return;
    this.nodes.delete(nodeId);
    this.ring = this.ring.filter((v) => v.nodeId !== nodeId);
  }

  /** Get the set of physical node IDs on the ring. */
  getNodes(): ReadonlySet<string> {
    return this.nodes;
  }

  /** Number of physical nodes. */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /**
   * Determine the owner node for a given key (roomId / fileId).
   *
   * Uses binary search to find the first vnode with hash >= key hash.
   * If no such vnode exists (key hash is beyond the last vnode), wraps
   * around to the first vnode (ring semantics).
   *
   * Returns undefined if the ring is empty.
   */
  getOwner(key: string): string | undefined {
    if (this.ring.length === 0) return undefined;

    const keyHash = crc32(key);

    // Binary search for first vnode with hash >= keyHash
    let lo = 0;
    let hi = this.ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid]!.hash < keyHash) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    // Wrap around if we fell off the end
    if (lo >= this.ring.length) lo = 0;

    return this.ring[lo]!.nodeId;
  }

  /**
   * Compute the ownership map for a set of room IDs.
   *
   * @param roomIds  Room IDs to map to owners.
   * @returns Map<roomId, ownerNodeId>
   */
  computeOwnership(roomIds: Iterable<string>): Map<string, string> {
    const result = new Map<string, string>();
    for (const roomId of roomIds) {
      const owner = this.getOwner(roomId);
      if (owner) result.set(roomId, owner);
    }
    return result;
  }

  /**
   * Compute the rebalance transfers needed when the ring changes.
   *
   * @param currentOwnership  Map of roomId → current owner nodeId.
   * @returns transfers needed + new ownership map.
   */
  computeRebalance(currentOwnership: Map<string, string>): RebalanceResult {
    const transfers: OwnershipTransfer[] = [];
    const newOwnership = new Map<string, string>();

    for (const [roomId, currentOwner] of currentOwnership) {
      const idealOwner = this.getOwner(roomId);
      if (!idealOwner) continue;

      newOwnership.set(roomId, idealOwner);

      if (idealOwner !== currentOwner) {
        transfers.push({
          roomId,
          fromNodeId: currentOwner,
          toNodeId: idealOwner,
        });
      }
    }

    return { transfers, newOwnership };
  }

  /**
   * Rebuild the ring from a fresh set of node IDs.
   * Used when the topology changes (node join/leave).
   */
  rebuild(nodeIds: string[]): void {
    this.ring = [];
    this.nodes.clear();
    for (const id of nodeIds) this.addNode(id);
  }

  /** Get ring size (total vnodes) — useful for diagnostics. */
  get ringSize(): number {
    return this.ring.length;
  }
}

// ── Cluster membership manager ──────────────────────────────────────────────

export interface ClusterTopologyEvent {
  type: 'node_join' | 'node_leave' | 'node_crash';
  nodeId: string;
  timestamp: number;
  activeNodes: string[];
}

/**
 * Manages this node's membership in the PeerGrid cluster.
 *
 * Responsibilities:
 *   1. Register this node in Redis on startup
 *   2. Maintain heartbeat to signal liveness
 *   3. Detect dead nodes (heartbeat expiry)
 *   4. Publish topology change events
 *   5. Maintain the consistent hash ring
 */
export class ClusterMembership {
  private readonly nodeId: string;
  private readonly ring: ConsistentHashRing;
  private readonly nodeAddress: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  /** Current set of known active nodes. */
  private activeNodes = new Set<string>();
  /** Callbacks for topology changes. */
  private readonly onTopologyChange: Array<(event: ClusterTopologyEvent) => void> = [];

  constructor(nodeId: string) {
    this.nodeId = nodeId;
    this.nodeAddress = (process.env['NODE_WS_PUBLIC_URL'] ?? process.env['WS_PUBLIC_URL'] ?? '').trim();
    this.ring = new ConsistentHashRing();
  }

  /** Get the underlying hash ring. */
  getRing(): ConsistentHashRing {
    return this.ring;
  }

  /** Get this node's ID. */
  getNodeId(): string {
    return this.nodeId;
  }

  /** Get the set of currently active nodes. */
  getActiveNodes(): ReadonlySet<string> {
    return this.activeNodes;
  }

  /**
   * Register a callback for topology changes.
   * Called when nodes join, leave, or crash.
   */
  onTopology(callback: (event: ClusterTopologyEvent) => void): void {
    this.onTopologyChange.push(callback);
  }

  /**
   * Check if this node is the owner of a given room,
   * according to the consistent hash ring.
   */
  isOwner(roomId: string): boolean {
    return this.ring.getOwner(roomId) === this.nodeId;
  }

  /**
   * Get the owner node ID for a room.
   */
  getOwner(roomId: string): string | undefined {
    return this.ring.getOwner(roomId);
  }

  /** Get this node's configured public websocket address (if available). */
  getNodeAddress(): string | undefined {
    return this.nodeAddress.length > 0 ? this.nodeAddress : undefined;
  }

  /** Resolve the public websocket address for a specific node from Redis metadata. */
  async getNodeAddressFor(redis: import('ioredis').default, nodeId: string): Promise<string | undefined> {
    const value = await redis.get(nodeAddressKey(nodeId));
    if (!value || value.trim().length === 0) return undefined;
    return value.trim();
  }

  /**
   * Register this node in the cluster using Redis.
   *
   * @param redis  ioredis client instance.
   */
  async register(redis: import('ioredis').default): Promise<void> {
    const pipeline = redis.pipeline();
    // Add to node registry set
    pipeline.sadd(nodeRegistryKey(), this.nodeId);
    // Set heartbeat with TTL
    pipeline.set(nodeHeartbeatKey(this.nodeId), getClusterTimeMs().toString(), 'EX', NODE_HEARTBEAT_TTL_SEC);
    // Set public websocket address metadata with same TTL (refreshed by heartbeat)
    if (this.nodeAddress.length > 0) {
      pipeline.set(nodeAddressKey(this.nodeId), this.nodeAddress, 'EX', NODE_HEARTBEAT_TTL_SEC);
    }
    await pipeline.exec();

    // Load active nodes
    await this.refreshTopology(redis);

    // Broadcast node join so already-running peers rebuild their rings.
    const joinEvent: ClusterTopologyEvent = {
      type: 'node_join',
      nodeId: this.nodeId,
      timestamp: getClusterTimeMs(),
      activeNodes: [...this.activeNodes],
    };
    await redis.publish(TOPOLOGY_CHANGE_CHANNEL, JSON.stringify(joinEvent)).catch(() => {});

    // Start periodic heartbeat
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat(redis);
    }, NODE_HEARTBEAT_INTERVAL_MS);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();

    // Start periodic dead node scan (2x heartbeat TTL)
    this.scanTimer = setInterval(() => {
      void this.scanForDeadNodes(redis);
    }, NODE_HEARTBEAT_TTL_SEC * 1000);
    if (typeof this.scanTimer.unref === 'function') this.scanTimer.unref();

    getLogger().info(
      { nodeId: this.nodeId, activeNodes: this.activeNodes.size },
      '[cluster] node registered',
    );
  }

  /**
   * Deregister this node from the cluster (graceful shutdown).
   */
  async deregister(redis: import('ioredis').default): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.scanTimer) clearInterval(this.scanTimer);

    const pipeline = redis.pipeline();
    pipeline.srem(nodeRegistryKey(), this.nodeId);
    pipeline.del(nodeHeartbeatKey(this.nodeId));
    pipeline.del(nodeAddressKey(this.nodeId));
    pipeline.del(nodeRoomsKey(this.nodeId));
    await pipeline.exec();

    // Notify other nodes
    const event: ClusterTopologyEvent = {
      type: 'node_leave',
      nodeId: this.nodeId,
      timestamp: getClusterTimeMs(),
      activeNodes: [...this.activeNodes].filter((n) => n !== this.nodeId),
    };
    await redis.publish(TOPOLOGY_CHANGE_CHANNEL, JSON.stringify(event)).catch(() => {});

    getLogger().info({ nodeId: this.nodeId }, '[cluster] node deregistered');
  }

  /**
   * Handle a topology change message from Redis pub/sub.
   */
  handleTopologyChange(event: ClusterTopologyEvent): void {
    getLogger().info(
      { event: event.type, nodeId: event.nodeId, total: event.activeNodes.length },
      '[cluster] topology change received',
    );

    this.activeNodes = new Set(event.activeNodes);
    this.ring.rebuild([...this.activeNodes]);

    for (const cb of this.onTopologyChange) {
      try {
        cb(event);
      } catch (err) {
        getLogger().error({ err }, '[cluster] topology change callback error');
      }
    }
  }

  /**
   * Refresh topology from Redis — rebuilds the hash ring from the node set.
   */
  async refreshTopology(redis: import('ioredis').default): Promise<void> {
    const members = await redis.smembers(nodeRegistryKey());

    // Verify each member is still alive (heartbeat key exists)
    const alive: string[] = [];
    if (members.length > 0) {
      const pipeline = redis.pipeline();
      for (const m of members) pipeline.exists(nodeHeartbeatKey(m));
      const results = await pipeline.exec();
      for (let i = 0; i < members.length; i++) {
        const [err, exists] = results![i]!;
        if (!err && exists === 1) alive.push(members[i]!);
      }
    }

    const prevNodes = new Set(this.activeNodes);
    this.activeNodes = new Set(alive);
    this.ring.rebuild(alive);

    // Detect newly joined or left nodes
    for (const n of alive) {
      if (!prevNodes.has(n) && n !== this.nodeId) {
        getLogger().info({ nodeId: n }, '[cluster] new node detected');
      }
    }
    for (const n of prevNodes) {
      if (!this.activeNodes.has(n)) {
        getLogger().warn({ nodeId: n }, '[cluster] node no longer active');
      }
    }
  }

  private async sendHeartbeat(redis: import('ioredis').default): Promise<void> {
    try {
      const pipeline = redis.pipeline();
      pipeline.set(
        nodeHeartbeatKey(this.nodeId),
        getClusterTimeMs().toString(),
        'EX',
        NODE_HEARTBEAT_TTL_SEC,
      );
      if (this.nodeAddress.length > 0) {
        pipeline.set(nodeAddressKey(this.nodeId), this.nodeAddress, 'EX', NODE_HEARTBEAT_TTL_SEC);
      }
      await pipeline.exec();
    } catch (err) {
      getLogger().warn({ err }, '[cluster] heartbeat send failed');
    }
  }

  private async scanForDeadNodes(redis: import('ioredis').default): Promise<void> {
    try {
      const members = await redis.smembers(nodeRegistryKey());
      if (members.length === 0) return;

      const pipeline = redis.pipeline();
      for (const m of members) pipeline.exists(nodeHeartbeatKey(m));
      const results = await pipeline.exec();

      const deadNodes: string[] = [];
      for (let i = 0; i < members.length; i++) {
        const [err, exists] = results![i]!;
        if (!err && exists === 0) deadNodes.push(members[i]!);
      }

      if (deadNodes.length === 0) return;

      // Remove dead nodes from registry
      const cleanPipeline = redis.pipeline();
      for (const dead of deadNodes) {
        cleanPipeline.srem(nodeRegistryKey(), dead);
        cleanPipeline.del(nodeAddressKey(dead));
        cleanPipeline.del(nodeRoomsKey(dead));
      }
      await cleanPipeline.exec();

      // Rebuild topology
      const remaining = members.filter((m) => !deadNodes.includes(m));
      this.activeNodes = new Set(remaining);
      this.ring.rebuild(remaining);

      // Publish topology change
      for (const dead of deadNodes) {
        const event: ClusterTopologyEvent = {
          type: 'node_crash',
          nodeId: dead,
          timestamp: getClusterTimeMs(),
          activeNodes: remaining,
        };
        await redis.publish(TOPOLOGY_CHANGE_CHANNEL, JSON.stringify(event)).catch(() => {});

        for (const cb of this.onTopologyChange) {
          try { cb(event); } catch {}
        }
      }

      getLogger().warn(
        { deadNodes, remaining: remaining.length },
        '[cluster] dead nodes removed',
      );
    } catch (err) {
      getLogger().error({ err }, '[cluster] dead node scan failed');
    }
  }
}
