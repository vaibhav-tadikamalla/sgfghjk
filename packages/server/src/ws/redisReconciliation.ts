/**
 * redisReconciliation.ts
 *
 * Redis partition recovery and reconnection reconciliation protocol.
 *
 * Problem:
 *   When Redis disconnects (network partition, failover, restart), nodes lose
 *   the pub/sub channel.  Updates applied during the partition are not
 *   propagated cross-node, causing CRDT state divergence:
 *
 *     Node A: applies updates U1, U2, U3 → Y.Doc_A
 *     Node B: applies updates U4, U5     → Y.Doc_B
 *     ── Redis partition ──
 *     After reconnect: Y.Doc_A ≠ Y.Doc_B (both have valid but diverged state)
 *
 * Solution:
 *   On Redis reconnect, execute a full state vector reconciliation:
 *
 *     1. DETECT — Redis subscriber emits 'ready' event after reconnect.
 *     2. ANNOUNCE — Publish a `reconcile_request` message on a dedicated
 *        channel with this node's ID and the list of rooms it holds.
 *     3. EXCHANGE — Each receiving node computes Y.diffUpdate for rooms they
 *        share with the requesting node using the advertised state vector.
 *     4. MERGE — The requesting node applies received diffs to its local
 *        Y.Doc instances, achieving CRDT convergence.
 *
 *   Because Yjs is a CRDT, the merge order is irrelevant — all nodes converge
 *   to the same final state regardless of the order diffs are applied.
 *
 * Wire format (Redis pub/sub):
 *   Channel: `reconcile:<nodeId>`
 *
 *   Request:  { type: 'sv_request', nodeId, rooms: [{ fileId, stateVector: base64 }] }
 *   Response: { type: 'sv_response', nodeId, diffs: [{ fileId, diff: base64 }] }
 */

import * as Y from 'yjs';
import { getLogger } from '../utils/logger';
import { getClusterTimeMs } from './clusterClock';
import {
  redisPartitionCounter,
  redisReconciliationCounter,
  redisReconciliationDuration,
  stateVectorExchangeCounter,
} from '../metrics/advancedMetrics';

const logger = getLogger();

// ── Types ───────────────────────────────────────────────────────────────────

export interface RoomStateVector {
  fileId: string;
  /** Base64-encoded Yjs state vector (Y.encodeStateVector). */
  stateVector: string;
}

export interface RoomDiff {
  fileId: string;
  /** Base64-encoded Yjs diff update (Y.encodeStateAsUpdate with target SV). */
  diff: string;
}

export interface ReconcileRequest {
  type: 'sv_request';
  nodeId: string;
  rooms: RoomStateVector[];
  timestamp: number;
}

export interface ReconcileResponse {
  type: 'sv_response';
  nodeId: string;
  diffs: RoomDiff[];
  timestamp: number;
}

export type ReconcileMessage = ReconcileRequest | ReconcileResponse;

// ── Channel helpers ─────────────────────────────────────────────────────────

/** Per-node reconciliation channel — each node listens on its own channel. */
export function reconcileChannel(nodeId: string): string {
  return `reconcile:${nodeId}`;
}

/** Broadcast channel for discovery — all nodes subscribe. */
export const RECONCILE_BROADCAST_CHANNEL = 'reconcile:broadcast';

// ── State vector extraction ─────────────────────────────────────────────────

/**
 * Extract the state vector from a Y.Doc for reconciliation exchange.
 *
 * @param doc  The Y.Doc instance.
 * @returns Base64-encoded state vector string.
 */
export function extractStateVector(doc: Y.Doc): string {
  return Buffer.from(Y.encodeStateVector(doc)).toString('base64');
}

/**
 * Compute a diff update between a local Y.Doc and a remote state vector.
 *
 * The diff contains all operations present in the local doc that are NOT
 * present in the remote state vector.  Applying this diff to the remote
 * doc will bring it up to date with the local state.
 *
 * @param doc              Local Y.Doc instance.
 * @param remoteStateVector  Base64-encoded state vector from the remote node.
 * @returns Base64-encoded diff update, or null if no diff is needed.
 */
export function computeDiff(doc: Y.Doc, remoteStateVector: string): string | null {
  try {
    const remoteSv = Buffer.from(remoteStateVector, 'base64');
    const diff = Y.encodeStateAsUpdate(doc, new Uint8Array(remoteSv));

    // An empty diff means the remote already has everything we have
    if (diff.byteLength <= 2) return null; // Yjs empty update is 2 bytes

    return Buffer.from(diff).toString('base64');
  } catch (err) {
    logger.error({ err }, '[reconciliation] failed to compute diff');
    return null;
  }
}

/**
 * Apply a diff update from a remote node to a local Y.Doc.
 *
 * @param doc   Local Y.Doc instance.
 * @param diff  Base64-encoded diff update from the remote node.
 * @returns true if the diff was successfully applied.
 */
export function applyDiff(doc: Y.Doc, diff: string): boolean {
  try {
    const update = Buffer.from(diff, 'base64');
    Y.applyUpdate(doc, new Uint8Array(update));
    return true;
  } catch (err) {
    logger.error({ err }, '[reconciliation] failed to apply diff');
    return false;
  }
}

// ── Reconciliation orchestrator ─────────────────────────────────────────────

/**
 * Build a reconciliation request containing state vectors for all rooms
 * held by this node.
 *
 * @param nodeId  This node's unique identifier.
 * @param rooms   Iterator of [fileId, Y.Doc] pairs.
 * @returns ReconcileRequest message ready for Redis publish.
 */
export function buildReconcileRequest(
  nodeId: string,
  rooms: Iterable<[string, Y.Doc]>,
): ReconcileRequest {
  const roomStates: RoomStateVector[] = [];
  for (const [fileId, doc] of rooms) {
    roomStates.push({
      fileId,
      stateVector: extractStateVector(doc),
    });
  }

  stateVectorExchangeCounter.inc({ direction: 'sent' }, roomStates.length);

  return {
    type: 'sv_request',
    nodeId,
    rooms: roomStates,
    timestamp: getClusterTimeMs(),
  };
}

/**
 * Process a reconciliation request from a remote node and build a response
 * containing diffs for all shared rooms.
 *
 * @param request  The incoming ReconcileRequest.
 * @param getDoc   Function to retrieve a local Y.Doc by fileId.
 * @param nodeId   This node's identifier.
 * @returns ReconcileResponse with diffs for rooms that need updates.
 */
export function handleReconcileRequest(
  request: ReconcileRequest,
  getDoc: (fileId: string) => Y.Doc | undefined,
  nodeId: string,
): ReconcileResponse {
  const t0 = Date.now();
  const diffs: RoomDiff[] = [];

  stateVectorExchangeCounter.inc({ direction: 'received' }, request.rooms.length);

  for (const room of request.rooms) {
    const localDoc = getDoc(room.fileId);
    if (!localDoc) continue; // We don't have this room — skip

    const diff = computeDiff(localDoc, room.stateVector);
    if (diff) {
      diffs.push({ fileId: room.fileId, diff });
    }
  }

  const duration = Date.now() - t0;
  redisReconciliationDuration.observe(duration);
  redisReconciliationCounter.inc();

  logger.info(
    {
      remoteNodeId: request.nodeId,
      requestedRooms: request.rooms.length,
      diffsGenerated: diffs.length,
      durationMs: duration,
    },
    '[reconciliation] processed reconcile request',
  );

  return {
    type: 'sv_response',
    nodeId,
    diffs,
    timestamp: getClusterTimeMs(),
  };
}

/**
 * Apply diffs from a reconciliation response to local Y.Doc instances.
 *
 * @param response  The incoming ReconcileResponse.
 * @param getDoc    Function to retrieve a local Y.Doc by fileId.
 * @returns Number of diffs successfully applied.
 */
export function applyReconcileResponse(
  response: ReconcileResponse,
  getDoc: (fileId: string) => Y.Doc | undefined,
): number {
  const t0 = Date.now();
  let applied = 0;

  for (const roomDiff of response.diffs) {
    const doc = getDoc(roomDiff.fileId);
    if (!doc) continue;

    if (applyDiff(doc, roomDiff.diff)) {
      applied++;
    }
  }

  const duration = Date.now() - t0;
  logger.info(
    {
      remoteNodeId: response.nodeId,
      totalDiffs: response.diffs.length,
      appliedDiffs: applied,
      durationMs: duration,
    },
    '[reconciliation] applied reconcile response',
  );

  return applied;
}

/**
 * Record a Redis partition event in metrics.
 * Called when the subscriber connection emits 'close' or 'end'.
 */
export function recordPartitionEvent(): void {
  redisPartitionCounter.inc();
  logger.error('[reconciliation] Redis partition detected — will reconcile on reconnect');
}

