/**
 * admin/BenchmarkPage.tsx
 *
 * Main "Benchmark" tab content in the Admin Dashboard.
 * Composes all benchmark sub-components.
 */

import React, { useState } from 'react';
import { BenchmarkControls } from './BenchmarkControls';
import { BenchmarkLiveStatus } from './BenchmarkLiveStatus';
import { BenchmarkRunHistory } from './BenchmarkRunHistory';
import { BenchmarkRunDetail } from './BenchmarkRunDetail';
import { BenchmarkCharts } from './BenchmarkCharts';
import { useBenchmarkStatus, useBenchmarkRuns } from './benchmarkHooks';

export function BenchmarkPage() {
  const status = useBenchmarkStatus();
  const runs = useBenchmarkRuns({ limit: 30 });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const isRunning = status.data
    ? !['idle', 'completed', 'failed', 'cancelled'].includes(status.data.phase)
    : false;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200 uppercase tracking-wide">
            Performance Benchmark
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Measure collaborative edit propagation latency (t₁→t₂) and throughput under load.
          </p>
        </div>
        {isRunning && (
          <span className="flex items-center gap-1.5 text-xs text-amber-400 font-medium">
            <span className="w-2 h-2 bg-amber-400 rounded-full animate-pulse" />
            Benchmark running
          </span>
        )}
      </div>

      {/* Live status banner (only when running) */}
      {status.data && isRunning && (
        <BenchmarkLiveStatus status={status.data} />
      )}

      {/* Controls */}
      <BenchmarkControls isRunning={isRunning} />

      {/* Charts from completed runs */}
      {runs.data && runs.data.runs.filter(r => r.status === 'completed').length >= 2 && (
        <BenchmarkCharts runs={runs.data.runs.filter(r => r.status === 'completed')} />
      )}

      {/* Run history */}
      {runs.data && (
        <BenchmarkRunHistory
          runs={runs.data.runs}
          total={runs.data.total}
          selectedRunId={selectedRunId}
          onSelect={id => setSelectedRunId(id === selectedRunId ? null : id)}
        />
      )}

      {/* Detail panel for selected run */}
      {selectedRunId && (
        <BenchmarkRunDetail
          runId={selectedRunId}
          onClose={() => setSelectedRunId(null)}
        />
      )}

      {/* Methodology note */}
      <div className="bg-zinc-800/40 border border-zinc-700 rounded-lg p-4 text-xs text-zinc-500 space-y-1">
        <p className="font-medium text-zinc-400">Methodology notes</p>
        <p>
          <strong className="text-zinc-300">t₁</strong> = <code>performance.now()</code> captured in the sender editor immediately before <code>Y.Doc.transact()</code>.
        </p>
        <p>
          <strong className="text-zinc-300">t₂</strong> = <code>performance.now()</code> captured in a different editor immediately after <code>Y.applyUpdate()</code> processes the broadcasted update.
        </p>
        <p>
          All simulated editors run in the same Node.js process, making <code>performance.now()</code> monotonically comparable without clock sync.
          Latency includes: CRDT encode → WebSocket send → server broadcast → WebSocket receive → CRDT apply.
        </p>
        <p className="text-zinc-600">
          ⚠ Does not measure WAN latency. For deployed benchmarks, the server connects to its own WebSocket endpoint.
          CPU/memory shown is the PeerGrid server process (benchmark runner and server share the same process in single-node mode).
        </p>
      </div>
    </div>
  );
}
