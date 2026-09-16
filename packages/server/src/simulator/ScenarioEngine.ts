/**
 * simulator/ScenarioEngine.ts
 *
 * Defines simulation scenarios that control how editors are distributed
 * across cluster nodes and what events occur during the simulation.
 *
 * Scenarios:
 *   1. balanced      — editors spread evenly across all nodes & rooms
 *   2. hotspot       — all editors converge on a single document
 *   3. node-crash    — one node crashes mid-simulation, editors redistribute
 *   4. mirror-resync — mirrors are evicted, forcing resync from owner node
 *   5. reconnect-storm — all editors disconnect and reconnect simultaneously
 *
 * Each scenario is a declarative description plus a timeline of scheduled
 * events that the ClusterSimulator executes.
 */

import type { ClusterNode, NodeEditorAssignment } from './ClusterNode';
import { randomUUID } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ScenarioId =
  | 'balanced'
  | 'hotspot'
  | 'node-crash'
  | 'mirror-resync'
  | 'reconnect-storm';

export interface ScenarioEvent {
  /** Delay (ms) after simulation start when this event fires. */
  delayMs: number;
  /** Human-readable description for the dashboard timeline. */
  description: string;
  /** Action to execute. */
  action: ScenarioAction;
}

export type ScenarioAction =
  | { type: 'kill-node'; nodeId: string }
  | { type: 'partition-node'; nodeId: string }
  | { type: 'restore-node'; nodeId: string }
  | { type: 'degrade-node'; nodeId: string }
  | { type: 'evict-mirrors'; nodeId: string }
  | { type: 'reconnect-storm'; nodeIds: string[] }
  | { type: 'redistribute-editors'; fromNodeId: string; toNodeIds: string[] }
  | { type: 'log'; message: string };

export interface ScenarioDefinition {
  id: ScenarioId;
  name: string;
  description: string;
  /** How to distribute editors initially. */
  distribution: DistributionStrategy;
  /** Scheduled events during the simulation. */
  timeline: ScenarioEvent[];
}

export type DistributionStrategy =
  | { type: 'balanced' }
  | { type: 'hotspot'; hotspotRoom: string }
  | { type: 'weighted'; weights: Record<string, number> };

// ── Editor assignment logic ───────────────────────────────────────────────────

/**
 * Given a list of nodes and a total editor count, produce per-node
 * editor assignments according to the distribution strategy.
 */
export function computeEditorAssignments(
  nodes: ClusterNode[],
  totalEditors: number,
  targetRoom: string,
  strategy: DistributionStrategy,
): Map<string, NodeEditorAssignment[]> {
  const result = new Map<string, NodeEditorAssignment[]>();
  for (const node of nodes) result.set(node.nodeId, []);

  if (nodes.length === 0 || totalEditors === 0) return result;

  switch (strategy.type) {
    case 'balanced':
      return distributeBalanced(nodes, totalEditors, targetRoom, result);
    case 'hotspot':
      return distributeHotspot(nodes, totalEditors, strategy.hotspotRoom, result);
    case 'weighted':
      return distributeWeighted(nodes, totalEditors, targetRoom, strategy.weights, result);
    default:
      return distributeBalanced(nodes, totalEditors, targetRoom, result);
  }
}

function distributeBalanced(
  nodes: ClusterNode[],
  totalEditors: number,
  targetRoom: string,
  result: Map<string, NodeEditorAssignment[]>,
): Map<string, NodeEditorAssignment[]> {
  // Spread editors evenly across nodes, and across multiple rooms
  const roomCount = Math.max(1, Math.ceil(nodes.length * 1.5)); // ~1.5 rooms per node
  const rooms = Array.from({ length: roomCount }, (_, i) => `${targetRoom}-${i + 1}`);

  for (let i = 0; i < totalEditors; i++) {
    const node = nodes[i % nodes.length]!;
    const room = rooms[i % rooms.length]!;
    const editorId = `sim-editor-${i + 1}-${randomUUID().slice(0, 8)}`;

    result.get(node.nodeId)!.push({
      editorId,
      fileId: room,
      displayName: `Editor ${i + 1} (${node.label})`,
    });
  }

  return result;
}

function distributeHotspot(
  nodes: ClusterNode[],
  totalEditors: number,
  hotspotRoom: string,
  result: Map<string, NodeEditorAssignment[]>,
): Map<string, NodeEditorAssignment[]> {
  // All editors edit the same room but connect through different nodes
  for (let i = 0; i < totalEditors; i++) {
    const node = nodes[i % nodes.length]!;
    const editorId = `sim-editor-${i + 1}-${randomUUID().slice(0, 8)}`;

    result.get(node.nodeId)!.push({
      editorId,
      fileId: hotspotRoom,
      displayName: `Editor ${i + 1} (${node.label})`,
    });
  }

  return result;
}

function distributeWeighted(
  nodes: ClusterNode[],
  totalEditors: number,
  targetRoom: string,
  weights: Record<string, number>,
  result: Map<string, NodeEditorAssignment[]>,
): Map<string, NodeEditorAssignment[]> {
  // Distribute proportionally by weight
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  let assigned = 0;

  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n]!;
    const weight = weights[node.nodeId] ?? 1;
    const isLast = n === nodes.length - 1;
    const count = isLast
      ? totalEditors - assigned
      : Math.round((weight / totalWeight) * totalEditors);

    for (let i = 0; i < count && assigned < totalEditors; i++, assigned++) {
      const editorId = `sim-editor-${assigned + 1}-${randomUUID().slice(0, 8)}`;
      result.get(node.nodeId)!.push({
        editorId,
        fileId: `${targetRoom}-${(assigned % Math.max(1, Math.ceil(nodes.length))) + 1}`,
        displayName: `Editor ${assigned + 1} (${node.label})`,
      });
    }
  }

  return result;
}

// ── Scenario definitions ──────────────────────────────────────────────────────

/**
 * Build the scenario definition for a given scenario ID.
 * Node IDs are resolved dynamically from the cluster config.
 */
export function buildScenario(
  scenarioId: ScenarioId,
  nodeIds: string[],
  targetRoom: string,
): ScenarioDefinition {
  switch (scenarioId) {
    case 'balanced':
      return {
        id: 'balanced',
        name: 'Balanced Load',
        description: 'Editors distributed evenly across all nodes and rooms. Steady-state test.',
        distribution: { type: 'balanced' },
        timeline: [
          { delayMs: 0, description: 'All editors spawned with balanced distribution', action: { type: 'log', message: 'Balanced scenario started' } },
        ],
      };

    case 'hotspot':
      return {
        id: 'hotspot',
        name: 'Hotspot Document',
        description: 'All editors converge on a single document, creating cross-node contention.',
        distribution: { type: 'hotspot', hotspotRoom: `${targetRoom}-hotspot` },
        timeline: [
          { delayMs: 0, description: 'All editors connected to single document', action: { type: 'log', message: 'Hotspot scenario started — all editors on one doc' } },
        ],
      };

    case 'node-crash': {
      const crashTarget = nodeIds[Math.floor(nodeIds.length / 2)] ?? nodeIds[0]!;
      const survivors = nodeIds.filter(id => id !== crashTarget);
      return {
        id: 'node-crash',
        name: 'Node Crash',
        description: `Node "${crashTarget}" crashes after 15s. Editors lose connections and must redistribute.`,
        distribution: { type: 'balanced' },
        timeline: [
          { delayMs: 0, description: 'Editors spawned across all nodes', action: { type: 'log', message: 'Node crash scenario initialized' } },
          { delayMs: 15_000, description: `Crashing node ${crashTarget}`, action: { type: 'kill-node', nodeId: crashTarget } },
          { delayMs: 20_000, description: `Redistributing editors from ${crashTarget}`, action: { type: 'redistribute-editors', fromNodeId: crashTarget, toNodeIds: survivors } },
          { delayMs: 45_000, description: `Restoring node ${crashTarget}`, action: { type: 'restore-node', nodeId: crashTarget } },
        ],
      };
    }

    case 'mirror-resync': {
      const evictTarget = nodeIds[nodeIds.length - 1] ?? nodeIds[0]!;
      return {
        id: 'mirror-resync',
        name: 'Mirror Resync',
        description: `Mirror replicas on node "${evictTarget}" are evicted after 10s, forcing full resync.`,
        distribution: { type: 'balanced' },
        timeline: [
          { delayMs: 0, description: 'Balanced load established', action: { type: 'log', message: 'Mirror resync scenario started' } },
          { delayMs: 10_000, description: `Evicting mirrors on ${evictTarget}`, action: { type: 'evict-mirrors', nodeId: evictTarget } },
          { delayMs: 12_000, description: `Degrading node ${evictTarget}`, action: { type: 'degrade-node', nodeId: evictTarget } },
          { delayMs: 30_000, description: `Restoring node ${evictTarget}`, action: { type: 'restore-node', nodeId: evictTarget } },
        ],
      };
    }

    case 'reconnect-storm':
      return {
        id: 'reconnect-storm',
        name: 'Reconnect Storm',
        description: 'All editors disconnect and reconnect simultaneously after 10s, simulating infrastructure restart.',
        distribution: { type: 'balanced' },
        timeline: [
          { delayMs: 0, description: 'Editors spawned normally', action: { type: 'log', message: 'Reconnect storm scenario initialized' } },
          { delayMs: 10_000, description: 'Triggering reconnect storm on all nodes', action: { type: 'reconnect-storm', nodeIds: [...nodeIds] } },
          { delayMs: 25_000, description: 'Second reconnect storm', action: { type: 'reconnect-storm', nodeIds: [...nodeIds] } },
        ],
      };

    default:
      return buildScenario('balanced', nodeIds, targetRoom);
  }
}
