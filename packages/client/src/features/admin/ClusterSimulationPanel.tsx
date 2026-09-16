import React, { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  simulationApi,
  type ClusterFailureType,
  type ClusterScenarioId,
  type ClusterSimulationSnapshot,
} from './api';

interface Props {
  snapshot: ClusterSimulationSnapshot;
}

const SCENARIOS: Array<{ id: ClusterScenarioId; label: string }> = [
  { id: 'balanced', label: 'Balanced Load' },
  { id: 'hotspot', label: 'Hotspot Document' },
  { id: 'node-crash', label: 'Node Crash' },
  { id: 'mirror-resync', label: 'Mirror Resync' },
  { id: 'reconnect-storm', label: 'Reconnect Storm' },
];

const FAILURE_TYPES: Array<{ id: ClusterFailureType; label: string }> = [
  { id: 'node-shutdown', label: 'Node Shutdown' },
  { id: 'redis-delay', label: 'Redis Delay' },
  { id: 'network-partition', label: 'Network Partition' },
  { id: 'mirror-eviction', label: 'Mirror Eviction' },
];

export function ClusterSimulationPanel({ snapshot }: Props) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'simulation', 'cluster'] });

  const [editorCount, setEditorCount] = useState(120);
  const [targetRoom, setTargetRoom] = useState('sim-cluster-room');
  const [scenario, setScenario] = useState<ClusterScenarioId>('balanced');
  const [nodesText, setNodesText] = useState([
    'node-a|Node A|ws://localhost:3000/ws',
    'node-b|Node B|ws://localhost:3001/ws',
    'node-c|Node C|ws://localhost:3002/ws',
  ].join('\n'));

  const [failureType, setFailureType] = useState<ClusterFailureType>('network-partition');
  const [failureNode, setFailureNode] = useState('node-b');
  const [failureDurationMs, setFailureDurationMs] = useState(15000);

  const startMutation = useMutation({
    mutationFn: () => {
      const nodes = parseNodes(nodesText);
      return simulationApi.startCluster({
        editorCount,
        targetRoom,
        scenario,
        nodes,
      });
    },
    onSuccess: invalidate,
  });

  const stopMutation = useMutation({
    mutationFn: () => simulationApi.stopCluster(),
    onSuccess: invalidate,
  });

  const injectMutation = useMutation({
    mutationFn: () => simulationApi.injectClusterFailure({
      type: failureType,
      nodeId: failureNode,
      durationMs: failureType === 'redis-delay' || failureType === 'network-partition' ? failureDurationMs : undefined,
    }),
    onSuccess: invalidate,
  });

  const resolveMutation = useMutation({
    mutationFn: (eventId: string) => simulationApi.resolveClusterFailure(eventId),
    onSuccess: invalidate,
  });

  const isRunning = snapshot.state === 'running' || snapshot.state === 'starting';

  const nodeMax = useMemo(() => Math.max(1, ...snapshot.nodeLoad.map(n => n.editors)), [snapshot.nodeLoad]);

  return (
    <div className="space-y-6">
      <div className="bg-zinc-800/60 border border-zinc-700 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-200 uppercase tracking-wide">Cluster Simulation</h2>
          <span className="text-xs text-zinc-400">State: <span className="text-zinc-200 font-medium">{snapshot.state}</span></span>
        </div>

        <div className="grid md:grid-cols-3 gap-3">
          <label className="text-xs text-zinc-400">
            Editors
            <input
              type="number"
              min={1}
              max={1000}
              value={editorCount}
              onChange={e => setEditorCount(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))}
              disabled={isRunning}
              className="mt-1 w-full px-3 py-2 rounded-md bg-zinc-700/50 border border-zinc-600 text-zinc-200"
            />
          </label>

          <label className="text-xs text-zinc-400">
            Target Room
            <input
              type="text"
              value={targetRoom}
              onChange={e => setTargetRoom(e.target.value)}
              disabled={isRunning}
              className="mt-1 w-full px-3 py-2 rounded-md bg-zinc-700/50 border border-zinc-600 text-zinc-200"
            />
          </label>

          <label className="text-xs text-zinc-400">
            Scenario
            <select
              value={scenario}
              onChange={e => setScenario(e.target.value as ClusterScenarioId)}
              disabled={isRunning}
              className="mt-1 w-full px-3 py-2 rounded-md bg-zinc-700/50 border border-zinc-600 text-zinc-200"
            >
              {SCENARIOS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
        </div>

        <label className="text-xs text-zinc-400 block">
          Nodes (one per line: nodeId|label|wsUrl)
          <textarea
            value={nodesText}
            onChange={e => setNodesText(e.target.value)}
            disabled={isRunning}
            rows={4}
            className="mt-1 w-full px-3 py-2 rounded-md bg-zinc-700/50 border border-zinc-600 text-zinc-200 font-mono text-xs"
          />
        </label>

        <div className="flex gap-3">
          <button
            onClick={() => startMutation.mutate()}
            disabled={isRunning || startMutation.isPending}
            className="flex-1 px-4 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-sm font-semibold text-white disabled:opacity-40"
          >
            {startMutation.isPending ? 'Starting…' : 'Start Cluster Simulation'}
          </button>
          <button
            onClick={() => stopMutation.mutate()}
            disabled={!isRunning || stopMutation.isPending}
            className="flex-1 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-sm font-semibold text-white disabled:opacity-40"
          >
            {stopMutation.isPending ? 'Stopping…' : 'Stop Cluster Simulation'}
          </button>
        </div>

        {(startMutation.error || stopMutation.error) && (
          <div className="text-xs text-red-300 bg-red-900/30 border border-red-800 rounded-md p-3">
            {String(startMutation.error || stopMutation.error)}
          </div>
        )}
      </div>

      <div className="grid md:grid-cols-4 gap-3">
        <MetricCard label="Node Load" value={snapshot.aggregate.totalEditors} sub={`${snapshot.nodeLoad.length} nodes`} />
        <MetricCard label="Rooms/Node" value={(snapshot.aggregate.totalRooms / Math.max(1, snapshot.nodeLoad.length)).toFixed(1)} sub={`${snapshot.aggregate.totalRooms} total rooms`} />
        <MetricCard label="Replication Lag" value={`${snapshot.aggregate.replicationLagMs}ms`} sub="estimated" />
        <MetricCard label="Cross-node Broadcasts" value={`${snapshot.aggregate.crossNodeBroadcastsPerSecond.toFixed(1)}/s`} sub="estimated" />
      </div>

      <div className="bg-zinc-800/60 border border-zinc-700 rounded-xl p-5 space-y-3">
        <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">Node Load</h3>
        {snapshot.nodeLoad.length === 0 && <div className="text-xs text-zinc-500">No active cluster simulation.</div>}
        {snapshot.nodeLoad.map(node => {
          const width = `${Math.max(4, (node.editors / nodeMax) * 100)}%`;
          const color = node.health === 'healthy' ? 'bg-green-500' : node.health === 'degraded' ? 'bg-yellow-500' : 'bg-red-500';
          return (
            <div key={node.nodeId} className="space-y-1">
              <div className="flex justify-between text-xs text-zinc-400">
                <span>{node.label} ({node.nodeId})</span>
                <span>{node.editors} editors • {node.health}</span>
              </div>
              <div className="h-2 rounded bg-zinc-700 overflow-hidden">
                <div className={`h-full ${color}`} style={{ width }} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-zinc-800/60 border border-zinc-700 rounded-xl p-5 space-y-3">
        <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">Failure Injection</h3>
        <div className="grid md:grid-cols-4 gap-3">
          <select value={failureType} onChange={e => setFailureType(e.target.value as ClusterFailureType)} className="px-3 py-2 rounded-md bg-zinc-700/50 border border-zinc-600 text-sm text-zinc-200">
            {FAILURE_TYPES.map(ft => <option key={ft.id} value={ft.id}>{ft.label}</option>)}
          </select>
          <input
            type="text"
            value={failureNode}
            onChange={e => setFailureNode(e.target.value)}
            placeholder="node-a"
            className="px-3 py-2 rounded-md bg-zinc-700/50 border border-zinc-600 text-sm text-zinc-200"
          />
          <input
            type="number"
            value={failureDurationMs}
            onChange={e => setFailureDurationMs(Math.max(1000, Number(e.target.value) || 1000))}
            className="px-3 py-2 rounded-md bg-zinc-700/50 border border-zinc-600 text-sm text-zinc-200"
          />
          <button
            onClick={() => injectMutation.mutate()}
            disabled={injectMutation.isPending || !isRunning}
            className="px-4 py-2 rounded-md bg-amber-600 hover:bg-amber-500 text-sm font-semibold text-white disabled:opacity-40"
          >
            Inject Failure
          </button>
        </div>

        {snapshot.failures.active.length > 0 && (
          <div className="space-y-2 pt-1">
            {snapshot.failures.active.map(f => (
              <div key={f.id} className="flex items-center justify-between bg-zinc-900/60 border border-zinc-700 rounded-md px-3 py-2">
                <div className="text-xs text-zinc-300">{f.description}</div>
                <button
                  onClick={() => resolveMutation.mutate(f.id)}
                  disabled={resolveMutation.isPending}
                  className="px-2.5 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white"
                >
                  Resolve
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-zinc-800/60 border border-zinc-700 rounded-xl p-5">
        <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wide mb-3">Scenario Timeline</h3>
        <div className="max-h-56 overflow-y-auto space-y-2">
          {snapshot.timeline.length === 0 && <div className="text-xs text-zinc-500">No events yet.</div>}
          {snapshot.timeline.slice().reverse().map((entry, idx) => (
            <div key={`${entry.ts}-${idx}`} className="text-xs text-zinc-400">
              <span className="text-zinc-500">{new Date(entry.ts).toLocaleTimeString()}</span> — {entry.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function parseNodes(text: string): Array<{ nodeId: string; label: string; wsUrl: string }> {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [nodeIdRaw, labelRaw, wsUrlRaw] = line.split('|').map(part => (part ?? '').trim());
      return {
        nodeId: nodeIdRaw || `node-${index + 1}`,
        label: labelRaw || nodeIdRaw || `Node ${index + 1}`,
        wsUrl: wsUrlRaw || '',
      };
    })
    .filter(node => Boolean(node.wsUrl));
}

function MetricCard({ label, value, sub }: { label: string; value: string | number; sub: string }) {
  return (
    <div className="bg-zinc-800/60 border border-zinc-700 rounded-lg p-4">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-xl font-bold text-zinc-100 mt-1">{value}</div>
      <div className="text-xs text-zinc-500 mt-0.5">{sub}</div>
    </div>
  );
}
