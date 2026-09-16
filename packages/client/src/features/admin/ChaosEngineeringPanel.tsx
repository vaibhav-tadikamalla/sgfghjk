import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { simulationApi, type ChaosSnapshot, type ChaosFailureType } from './api';

interface Props {
  snapshot: ChaosSnapshot;
  clusterRunning: boolean;
}

const FAILURE_LABELS: Array<{ type: ChaosFailureType; label: string }> = [
  { type: 'node-crash', label: 'Node Crash' },
  { type: 'redis-delay', label: 'Redis Delay' },
  { type: 'network-partition', label: 'Net Partition' },
  { type: 'mirror-eviction', label: 'Mirror Evict' },
  { type: 'connection-storm', label: 'Conn Storm' },
];

export function ChaosEngineeringPanel({ snapshot, clusterRunning }: Props) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'simulation', 'chaos'] });
    queryClient.invalidateQueries({ queryKey: ['admin', 'simulation', 'cluster'] });
  };

  const [chaosInterval, setChaosInterval] = useState(snapshot.config.intervalSeconds);
  const [maxFailures, setMaxFailures] = useState(snapshot.config.maxConcurrentFailures);
  const [recoverySeconds, setRecoverySeconds] = useState(snapshot.config.recoverySeconds);

  const startMutation = useMutation({
    mutationFn: () =>
      simulationApi.startChaos({
        intervalSeconds: chaosInterval,
        maxConcurrentFailures: maxFailures,
        recoverySeconds,
      }),
    onSuccess: invalidate,
  });

  const stopMutation = useMutation({
    mutationFn: () => simulationApi.stopChaos(),
    onSuccess: invalidate,
  });

  const configureMutation = useMutation({
    mutationFn: () =>
      simulationApi.configureChaos({
        intervalSeconds: chaosInterval,
        maxConcurrentFailures: maxFailures,
        recoverySeconds,
      }),
    onSuccess: invalidate,
  });

  const isRunning = snapshot.state === 'running';
  const isPaused = snapshot.state === 'paused';

  return (
    <div className="space-y-6">
      {/* ── Config + Controls ─────────────────────────────────────────── */}
      <div className="bg-zinc-800/60 border border-zinc-700 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-200 uppercase tracking-wide">
            Chaos Engine
          </h3>
          <span
            className={`text-xs px-2 py-0.5 rounded-full border ${
              isRunning
                ? 'bg-red-900/50 text-red-400 border-red-800'
                : isPaused
                  ? 'bg-yellow-900/50 text-yellow-400 border-yellow-800'
                  : 'bg-zinc-800 text-zinc-400 border-zinc-700'
            }`}
          >
            {snapshot.state}
          </span>
        </div>

        <div className="grid md:grid-cols-3 gap-3">
          <label className="text-xs text-zinc-400">
            Interval (seconds)
            <input
              type="number"
              min={5}
              max={600}
              value={chaosInterval}
              onChange={(e) => setChaosInterval(Math.max(5, Number(e.target.value) || 60))}
              disabled={isRunning}
              className="mt-1 w-full px-3 py-2 rounded-md bg-zinc-700/50 border border-zinc-600 text-zinc-200"
            />
          </label>
          <label className="text-xs text-zinc-400">
            Max Concurrent Failures
            <input
              type="number"
              min={1}
              max={10}
              value={maxFailures}
              onChange={(e) => setMaxFailures(Math.max(1, Math.min(10, Number(e.target.value) || 2)))}
              disabled={isRunning}
              className="mt-1 w-full px-3 py-2 rounded-md bg-zinc-700/50 border border-zinc-600 text-zinc-200"
            />
          </label>
          <label className="text-xs text-zinc-400">
            Recovery Time (seconds)
            <input
              type="number"
              min={10}
              max={600}
              value={recoverySeconds}
              onChange={(e) => setRecoverySeconds(Math.max(10, Number(e.target.value) || 120))}
              disabled={isRunning}
              className="mt-1 w-full px-3 py-2 rounded-md bg-zinc-700/50 border border-zinc-600 text-zinc-200"
            />
          </label>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => startMutation.mutate()}
            disabled={isRunning || !clusterRunning || startMutation.isPending}
            className="flex-1 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-sm font-semibold text-white disabled:opacity-40"
          >
            {startMutation.isPending ? 'Starting…' : 'Start Chaos'}
          </button>
          <button
            onClick={() => stopMutation.mutate()}
            disabled={snapshot.state === 'idle' || stopMutation.isPending}
            className="flex-1 px-4 py-2 rounded-lg bg-zinc-600 hover:bg-zinc-500 text-sm font-semibold text-white disabled:opacity-40"
          >
            {stopMutation.isPending ? 'Stopping…' : 'Stop Chaos'}
          </button>
          {isRunning && (
            <button
              onClick={() => configureMutation.mutate()}
              disabled={configureMutation.isPending}
              className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-sm font-semibold text-white disabled:opacity-40"
            >
              Apply Config
            </button>
          )}
        </div>

        {!clusterRunning && (
          <div className="text-xs text-amber-300 bg-amber-900/20 border border-amber-800 rounded-md p-2">
            Start a cluster simulation first to enable chaos engineering.
          </div>
        )}

        {(startMutation.error || stopMutation.error) && (
          <div className="text-xs text-red-300 bg-red-900/30 border border-red-800 rounded-md p-3">
            {String(startMutation.error || stopMutation.error)}
          </div>
        )}
      </div>

      {/* ── KPI Metrics ───────────────────────────────────────────────── */}
      <div className="grid md:grid-cols-4 gap-3">
        <MetricCard
          label="Active Failures"
          value={snapshot.activeFailures.length}
          sub={`of ${snapshot.config.maxConcurrentFailures} max`}
          highlight={snapshot.activeFailures.length > 0 ? 'red' : undefined}
        />
        <MetricCard
          label="MTTR"
          value={
            snapshot.metrics.meanTimeToRecoveryMs > 0
              ? `${(snapshot.metrics.meanTimeToRecoveryMs / 1000).toFixed(1)}s`
              : '—'
          }
          sub={`target: ${snapshot.config.recoverySeconds}s`}
        />
        <MetricCard
          label="Resilience"
          value={snapshot.metrics.resilienceScore}
          sub="0–100 composite"
          highlight={
            snapshot.metrics.resilienceScore < 50
              ? 'red'
              : snapshot.metrics.resilienceScore < 80
                ? 'yellow'
                : 'green'
          }
        />
        <MetricCard
          label="Availability"
          value={`${snapshot.metrics.availabilityPercent}%`}
          sub={`${snapshot.totalInjections} total injections`}
          highlight={
            snapshot.metrics.availabilityPercent < 90
              ? 'red'
              : snapshot.metrics.availabilityPercent < 99
                ? 'yellow'
                : 'green'
          }
        />
      </div>

      {/* ── Active Failures ───────────────────────────────────────────── */}
      {snapshot.activeFailures.length > 0 && (
        <div className="bg-zinc-800/60 border border-red-800/50 rounded-xl p-5 space-y-3">
          <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wide">
            Active Failures ({snapshot.activeFailures.length})
          </h3>
          {snapshot.activeFailures.map((f) => (
            <div
              key={f.id}
              className="flex items-center justify-between bg-zinc-900/60 border border-zinc-700 rounded-md px-3 py-2"
            >
              <div className="flex-1">
                <div className="text-xs text-zinc-300">{f.description}</div>
                <div className="text-[11px] text-zinc-500 mt-0.5">
                  Recovery scheduled: {new Date(f.scheduledRecoveryAt).toLocaleTimeString()}
                </div>
              </div>
              <span className={`text-[10px] px-2 py-0.5 rounded-full ${typeColor(f.type)}`}>
                {f.type}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── Failure Distribution ──────────────────────────────────────── */}
      <div className="bg-zinc-800/60 border border-zinc-700 rounded-xl p-5 space-y-3">
        <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">
          Failure Distribution
        </h3>
        <div className="grid grid-cols-5 gap-2">
          {FAILURE_LABELS.map(({ type, label }) => {
            const count = snapshot.metrics.failuresByType[type] ?? 0;
            const recovered = snapshot.metrics.recoveredByType[type] ?? 0;
            return (
              <div
                key={type}
                className="bg-zinc-900/60 border border-zinc-700 rounded-md p-3 text-center"
              >
                <div className="text-lg font-bold text-zinc-200">{count}</div>
                <div className="text-[10px] text-zinc-500 uppercase">{label}</div>
                <div className="text-[10px] text-green-500 mt-1">{recovered} recovered</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Failures by Node ──────────────────────────────────────────── */}
      {snapshot.metrics.nodeFailureCounts.length > 0 && (
        <div className="bg-zinc-800/60 border border-zinc-700 rounded-xl p-5 space-y-3">
          <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">
            Failures by Node
          </h3>
          <div className="space-y-2">
            {snapshot.metrics.nodeFailureCounts.map((n) => {
              const maxCount = Math.max(
                1,
                ...snapshot.metrics.nodeFailureCounts.map((x) => x.count),
              );
              const width = `${Math.max(8, (n.count / maxCount) * 100)}%`;
              return (
                <div key={n.nodeId} className="space-y-1">
                  <div className="flex justify-between text-xs text-zinc-400">
                    <span>{n.nodeId}</span>
                    <span>{n.count} failures</span>
                  </div>
                  <div className="h-2 rounded bg-zinc-700 overflow-hidden">
                    <div className="h-full bg-red-500/70" style={{ width }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Chaos Timeline ────────────────────────────────────────────── */}
      <div className="bg-zinc-800/60 border border-zinc-700 rounded-xl p-5">
        <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wide mb-3">
          Chaos Timeline
        </h3>
        <div className="max-h-56 overflow-y-auto space-y-2">
          {snapshot.timeline.length === 0 && (
            <div className="text-xs text-zinc-500">No chaos events yet.</div>
          )}
          {snapshot.timeline
            .slice()
            .reverse()
            .map((event, idx) => (
              <div key={`${event.id}-${idx}`} className="flex items-start gap-2 text-xs">
                <span className="text-zinc-500 shrink-0">
                  {new Date(event.timestamp).toLocaleTimeString()}
                </span>
                <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${typeColor(event.type)}`}>
                  {event.type}
                </span>
                <span className={event.resolved ? 'text-zinc-500' : 'text-zinc-300'}>
                  {event.description}
                </span>
                {event.resolved && event.resolvedAt && (
                  <span className="text-green-500 shrink-0">
                    recovered {((event.resolvedAt - event.timestamp) / 1000).toFixed(0)}s
                  </span>
                )}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function typeColor(type: string): string {
  switch (type) {
    case 'node-crash':
      return 'bg-red-900/50 text-red-400';
    case 'redis-delay':
      return 'bg-yellow-900/50 text-yellow-400';
    case 'network-partition':
      return 'bg-orange-900/50 text-orange-400';
    case 'mirror-eviction':
      return 'bg-purple-900/50 text-purple-400';
    case 'connection-storm':
      return 'bg-blue-900/50 text-blue-400';
    default:
      return 'bg-zinc-800 text-zinc-400';
  }
}

function MetricCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string | number;
  sub: string;
  highlight?: 'red' | 'yellow' | 'green';
}) {
  const borderClass =
    highlight === 'red'
      ? 'border-red-800/50'
      : highlight === 'yellow'
        ? 'border-yellow-800/50'
        : highlight === 'green'
          ? 'border-green-800/50'
          : 'border-zinc-700';
  const valueClass =
    highlight === 'red'
      ? 'text-red-400'
      : highlight === 'yellow'
        ? 'text-yellow-400'
        : highlight === 'green'
          ? 'text-green-400'
          : 'text-zinc-100';
  return (
    <div className={`bg-zinc-800/60 border ${borderClass} rounded-lg p-4`}>
      <div className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`text-xl font-bold ${valueClass} mt-1`}>{value}</div>
      <div className="text-xs text-zinc-500 mt-0.5">{sub}</div>
    </div>
  );
}
