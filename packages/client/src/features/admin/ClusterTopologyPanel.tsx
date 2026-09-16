import React from 'react';
import type { TopologyResponse } from './api';

interface Props {
  topology: TopologyResponse;
}

/**
 * Cluster Topology Panel — visualizes distributed state across nodes.
 * Shows per-node: rooms owned, mirror replicas, connections, updates applied.
 */
export function ClusterTopologyPanel({ topology }: Props) {
  const { nodes, mode, localNodeId, totalRooms, totalConnections } = topology;

  return (
    <div className="bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-white">Cluster Topology</h3>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
            mode === 'distributed'
              ? 'bg-blue-900/50 text-blue-300 border-blue-800'
              : 'bg-zinc-700 text-zinc-400 border-zinc-600'
          }`}>
            {mode}
          </span>
        </div>
        <span className="text-xs text-zinc-500">
          {nodes.length} node{nodes.length !== 1 ? 's' : ''} &middot;{' '}
          {totalRooms} rooms &middot; {totalConnections} conns
        </span>
      </div>

      {nodes.length === 0 ? (
        <div className="p-8 text-center text-sm text-zinc-500">No cluster nodes detected</div>
      ) : (
        <div className="p-4 grid gap-4 md:grid-cols-2">
          {nodes.map((node) => {
            const isLocal = node.nodeId === localNodeId || node.nodeId === 'local';
            const roomShare = totalRooms > 0
              ? Math.round((node.ownedRooms / totalRooms) * 100)
              : 0;

            return (
              <div
                key={node.nodeId}
                className={`rounded-lg border p-4 space-y-3 ${
                  isLocal
                    ? 'border-blue-700/60 bg-blue-900/10'
                    : 'border-zinc-700 bg-zinc-900/30'
                }`}
              >
                {/* Node header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`w-2.5 h-2.5 rounded-full ${
                      isLocal ? 'bg-blue-400' : 'bg-green-400'
                    }`} />
                    <span className="text-sm font-mono font-medium text-zinc-200" title={node.nodeId}>
                      {node.nodeId === 'local'
                        ? 'Local Node'
                        : node.nodeId.length > 16
                          ? node.nodeId.slice(0, 16) + '…'
                          : node.nodeId}
                    </span>
                    {isLocal && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-blue-900/40 text-blue-300 rounded border border-blue-800">
                        this node
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-zinc-500 tabular-nums">{roomShare}% of rooms</span>
                </div>

                {/* Metrics grid */}
                <div className="grid grid-cols-2 gap-2">
                  <MetricCell label="Owned Rooms" value={node.ownedRooms} color="text-amber-400" />
                  <MetricCell label="Mirrors" value={node.mirrorReplicas} color="text-cyan-400" />
                  <MetricCell label="Connections" value={node.connections} color="text-green-400" />
                  <MetricCell label="Updates" value={node.totalUpdatesApplied.toLocaleString()} color="text-purple-400" />
                </div>

                {/* Room distribution bar */}
                <div>
                  <div className="text-[10px] text-zinc-500 mb-1">Room load</div>
                  <div className="h-2 bg-zinc-700 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        isLocal ? 'bg-blue-500' : 'bg-green-500'
                      }`}
                      style={{ width: `${Math.max(2, roomShare)}%` }}
                    />
                  </div>
                </div>

                {/* Room IDs (collapsed if > 5) */}
                {node.roomIds.length > 0 && (
                  <details className="text-xs">
                    <summary className="text-zinc-500 cursor-pointer hover:text-zinc-300 transition-colors">
                      {node.roomIds.length} room{node.roomIds.length !== 1 ? 's' : ''}
                    </summary>
                    <div className="mt-1 flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                      {node.roomIds.map(id => (
                        <span
                          key={id}
                          className="inline-block px-1.5 py-0.5 bg-zinc-800 rounded text-zinc-400 font-mono truncate max-w-[140px]"
                          title={id}
                        >
                          {id}
                        </span>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MetricCell({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="bg-zinc-800/60 rounded px-2 py-1.5">
      <div className="text-[10px] text-zinc-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
