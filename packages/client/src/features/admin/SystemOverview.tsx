import React from 'react';
import type { SystemMetrics, ClusterInfo } from './api';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

interface Props {
  system: SystemMetrics;
  cluster: ClusterInfo;
}

export function SystemOverview({ system, cluster }: Props) {
  const cards = [
    { label: 'Active Users', value: system.activeUsers, color: 'bg-blue-500' },
    { label: 'Editors', value: system.activeEditors, color: 'bg-green-500' },
    { label: 'Viewers', value: system.activeViewers, color: 'bg-purple-500' },
    { label: 'Open Rooms', value: system.totalRooms, color: 'bg-amber-500' },
    { label: 'WebSocket Conns', value: system.websocketConnections, color: 'bg-cyan-500' },
    { label: 'Edits/min', value: system.editsPerMinute, color: 'bg-rose-500' },
  ];

  return (
    <div className="space-y-4">
      {/* Metric Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {cards.map(c => (
          <div key={c.label} className="bg-zinc-800 rounded-lg p-4 border border-zinc-700">
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-2 h-2 rounded-full ${c.color}`} />
              <span className="text-xs text-zinc-400 uppercase tracking-wide">{c.label}</span>
            </div>
            <div className="text-2xl font-bold text-white">{c.value}</div>
          </div>
        ))}
      </div>

      {/* System Info Bar */}
      <div className="flex flex-wrap gap-4 text-xs text-zinc-400 bg-zinc-800/50 rounded-lg px-4 py-2 border border-zinc-700/50">
        <span>Uptime: <span className="text-zinc-200">{formatUptime(system.uptimeSeconds)}</span></span>
        <span>Heap: <span className="text-zinc-200">{formatBytes(system.memory.heapUsed)} / {formatBytes(system.memory.heapTotal)}</span></span>
        <span>RSS: <span className="text-zinc-200">{formatBytes(system.memory.rss)}</span></span>
        <span>Cluster: <span className="text-zinc-200">{cluster.mode}</span></span>
        {cluster.nodeId && <span>Node: <span className="text-zinc-200 font-mono">{cluster.nodeId.slice(0, 8)}…</span></span>}
        {cluster.activeNodes.length > 0 && <span>Nodes: <span className="text-zinc-200">{cluster.activeNodes.length}</span></span>}
      </div>
    </div>
  );
}
