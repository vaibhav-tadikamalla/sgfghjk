import React from 'react';
import type { HealthInfo } from './api';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

interface Props {
  health: HealthInfo;
}

export function CollaborationHealth({ health }: Props) {
  const ownerEntries = Object.entries(health.ownerNodeDistribution);

  return (
    <div className="bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-700">
        <h3 className="text-sm font-semibold text-white">Collaboration Health</h3>
      </div>
      <div className="p-4 space-y-4">
        {/* Status Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatusCard
            label="Cluster Mode"
            value={health.cluster.mode}
            color="text-cyan-400"
          />
          <StatusCard
            label="Mirror Replicas"
            value={health.mirrorReplicas}
            color={health.mirrorReplicas > 0 ? 'text-green-400' : 'text-zinc-400'}
          />
          <StatusCard
            label="Dirty Rooms"
            value={health.dirtyRooms}
            color={health.dirtyRooms > 0 ? 'text-amber-400' : 'text-green-400'}
          />
          <StatusCard
            label="Total Rooms"
            value={health.totalRooms}
            color="text-blue-400"
          />
        </div>

        {/* Owner Node Distribution */}
        {ownerEntries.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Owner Node Distribution</h4>
            <div className="space-y-1">
              {ownerEntries.map(([nodeId, count]) => {
                const total = health.totalRooms || 1;
                const pct = Math.round((count / total) * 100);
                return (
                  <div key={nodeId} className="flex items-center gap-2">
                    <span className="text-xs font-mono text-zinc-400 w-24 truncate" title={nodeId}>
                      {nodeId === 'local' ? 'local' : nodeId.slice(0, 8) + '…'}
                    </span>
                    <div className="flex-1 h-4 bg-zinc-700 rounded-sm overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-sm transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-zinc-400 w-16 text-right">{count} ({pct}%)</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Memory */}
        <div>
          <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Memory</h4>
          <div className="flex flex-wrap gap-4 text-xs">
            <span className="text-zinc-400">Heap: <span className="text-zinc-200">{formatBytes(health.memory.heapUsed)} / {formatBytes(health.memory.heapTotal)}</span></span>
            <span className="text-zinc-400">RSS: <span className="text-zinc-200">{formatBytes(health.memory.rss)}</span></span>
            <span className="text-zinc-400">Uptime: <span className="text-zinc-200">{formatUptime(health.uptimeSeconds)}</span></span>
          </div>
          {/* Heap bar */}
          <div className="mt-1 h-2 bg-zinc-700 rounded-sm overflow-hidden">
            <div
              className={`h-full rounded-sm transition-all duration-500 ${
                health.memory.heapUsed / health.memory.heapTotal > 0.85
                  ? 'bg-red-500'
                  : health.memory.heapUsed / health.memory.heapTotal > 0.7
                    ? 'bg-amber-500'
                    : 'bg-green-500'
              }`}
              style={{ width: `${Math.round((health.memory.heapUsed / health.memory.heapTotal) * 100)}%` }}
            />
          </div>
        </div>

        {/* Cluster Nodes */}
        {health.cluster.activeNodes.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Active Nodes</h4>
            <div className="flex flex-wrap gap-2">
              {health.cluster.activeNodes.map(n => (
                <span key={n} className="inline-block px-2 py-1 bg-zinc-700 rounded text-xs font-mono text-zinc-300">
                  {n.slice(0, 12)}…
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="bg-zinc-900/50 rounded p-3">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
    </div>
  );
}
