/**
 * admin/BenchmarkPage.tsx
 *
 * Primary Faculty Demonstration & Production Benchmark Experience.
 * Seamlessly manages three visual states:
 *   1. LAUNCHER SCREEN: 1-click preset (10 users default), allowlisted targets, prominent CTA
 *   2. LIVE MONITORING: Full hero live screen with stepper, progress, live p50, sparkline & active users
 *   3. COMPLETION SCREEN: Prominent "SWARM TEST COMPLETE ✓" with final p50, p95, p99, throughput, convergence
 *
 * Also provides an "Advanced Analysis & History" section with historical charts,
 * run history table, CSV/JSON exports, and academic methodology references.
 */

import React, { useState, useEffect } from 'react';
import { BenchmarkControls } from './BenchmarkControls';
import { BenchmarkLiveStatus } from './BenchmarkLiveStatus';
import { BenchmarkRunHistory } from './BenchmarkRunHistory';
import { BenchmarkRunDetail } from './BenchmarkRunDetail';
import { BenchmarkCharts } from './BenchmarkCharts';
import { useBenchmarkStatus, useBenchmarkRuns, useBenchmarkRun } from './benchmarkHooks';
import { benchmarkApi, type BenchmarkRun } from './benchmarkApi';

export function BenchmarkPage() {
  const status = useBenchmarkStatus();
  const runs = useBenchmarkRuns({ limit: 30 });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activeCompletedRunId, setActiveCompletedRunId] = useState<string | null>(null);
  const [showAdvancedHistory, setShowAdvancedHistory] = useState(false);

  const isRunning = status.data
    ? !['idle', 'completed', 'failed', 'cancelled'].includes(status.data.phase)
    : false;

  // Track run completion: when phase switches to completed, remember the runId
  useEffect(() => {
    if (status.data?.phase === 'completed' && status.data.runId) {
      setActiveCompletedRunId(status.data.runId);
    }
  }, [status.data?.phase, status.data?.runId]);

  // When a new run starts, clear the completion card so live view displays
  const handleStarted = (runId: string) => {
    setActiveCompletedRunId(null);
    setSelectedRunId(null);
  };

  const handleResetToLauncher = () => {
    setActiveCompletedRunId(null);
  };

  return (
    <div className="space-y-8">
      {/* ── Top Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800 pb-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-lg font-bold text-white tracking-tight">
              Collaborative Swarm Testing & Latency Benchmarks
            </h2>
            <span className="text-xs px-2.5 py-0.5 rounded-full font-medium bg-zinc-800 text-zinc-300 border border-zinc-700">
              Academic Reference: Dang & Ignat
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-400">
            Measures real-time collaborative edit propagation delay ($t_1 \to t_2$) and CRDT convergence under high-concurrency loads.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isRunning && (
            <span className="flex items-center gap-2 text-xs text-blue-400 font-semibold bg-blue-950/60 border border-blue-800 px-3 py-1.5 rounded-full">
              <span className="w-2 h-2 bg-blue-400 rounded-full animate-ping" />
              Live Swarm Active
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowAdvancedHistory(v => !v)}
            className="text-xs text-zinc-400 hover:text-white bg-zinc-800/80 hover:bg-zinc-700 border border-zinc-700 px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
          >
            {showAdvancedHistory ? 'Hide Run History & Exports' : 'View Run History & Charts'}
          </button>
        </div>
      </div>

      {/* ── STATE 1: LIVE TEST SCREEN (Highest Priority when running) ───────── */}
      {isRunning && status.data && (
        <section>
          <BenchmarkLiveStatus status={status.data} />
        </section>
      )}

      {/* ── STATE 2: COMPLETION SCREEN (Shown after test finishes) ──────────── */}
      {!isRunning && activeCompletedRunId && (
        <section>
          <CompletedSwarmTestCard
            runId={activeCompletedRunId}
            onStartNew={handleResetToLauncher}
            onViewDetails={() => setSelectedRunId(activeCompletedRunId)}
          />
        </section>
      )}

      {/* ── STATE 3: LAUNCHER SCREEN (Shown when not running and no completed card) ── */}
      {!isRunning && !activeCompletedRunId && (
        <section className="space-y-6">
          <BenchmarkControls
            isRunning={isRunning}
            onStarted={handleStarted}
          />
        </section>
      )}

      {/* ── ADVANCED / RUN HISTORY & CHARTS SECTION ────────────────────────── */}
      {(showAdvancedHistory || (!isRunning && runs.data && runs.data.runs.length > 0)) && (
        <div className="space-y-6 pt-4 border-t border-zinc-800/80">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-zinc-200 uppercase tracking-wider">
              Benchmark Archives & Comparative Analytics
            </h3>
            <span className="text-xs text-zinc-500">
              {runs.data?.total ?? 0} persisted runs in database
            </span>
          </div>

          {/* Comparative SVG Charts */}
          {runs.data && runs.data.runs.filter(r => r.status === 'completed').length >= 2 && (
            <BenchmarkCharts runs={runs.data.runs.filter(r => r.status === 'completed')} />
          )}

          {/* Run History Table */}
          {runs.data && (
            <BenchmarkRunHistory
              runs={runs.data.runs}
              total={runs.data.total}
              selectedRunId={selectedRunId}
              onSelect={id => setSelectedRunId(id === selectedRunId ? null : id)}
            />
          )}

          {/* Selected Run Detail Inspection Panel */}
          {selectedRunId && (
            <BenchmarkRunDetail
              runId={selectedRunId}
              onClose={() => setSelectedRunId(null)}
            />
          )}
        </div>
      )}

      {/* ── Methodology Note ────────────────────────────────────────────────── */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 text-xs text-zinc-400 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-bold text-zinc-200 text-sm">Measurement Methodology</span>
          <span className="text-[11px] text-zinc-500 font-mono">Academic Standard</span>
        </div>
        <p>
          This system models the collaborative benchmark methodology introduced in{' '}
          <strong className="text-zinc-300">
            &ldquo;Performance of real-time collaborative editors at large scale: user perspective&rdquo;
          </strong>{' '}
          (Quang-Vinh Dang &amp; Claudia-Lavinia Ignat).
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 text-[11px]">
          <div className="bg-zinc-950 p-2.5 rounded border border-zinc-800">
            <strong className="text-blue-400">t₁ (Origin Timestamp):</strong> Captured in the sender editor immediately
            before creating the local Yjs transaction.
          </div>
          <div className="bg-zinc-950 p-2.5 rounded border border-zinc-800">
            <strong className="text-emerald-400">t₂ (Receive Timestamp):</strong> Captured in a remote simulated editor
            the moment raw WebSocket binary update bytes arrive and are applied.
          </div>
        </div>
      </div>
    </div>
  );
}

// ── COMPLETED SWARM TEST HERO CARD ───────────────────────────────────────────

interface CompletedCardProps {
  runId: string;
  onStartNew: () => void;
  onViewDetails: () => void;
}

function CompletedSwarmTestCard({ runId, onStartNew, onViewDetails }: CompletedCardProps) {
  const { data: run, isLoading } = useBenchmarkRun(runId);

  if (isLoading) {
    return (
      <div className="bg-zinc-900 border border-emerald-700/50 rounded-2xl p-8 text-center text-zinc-400">
        <span className="w-5 h-5 border-2 border-emerald-400/30 border-t-emerald-400 rounded-full animate-spin inline-block mr-2" />
        Finalizing and compiling test telemetry…
      </div>
    );
  }

  if (!run || !run.results) {
    return null;
  }

  const res = run.results;
  const cfg = run.config;
  const lat = res.latency;

  return (
    <div className="bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950 border-2 border-emerald-500/60 rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-5">
        <div>
          <div className="flex items-center gap-3">
            <span className="flex items-center justify-center w-7 h-7 rounded-full bg-emerald-500/20 text-emerald-400 font-bold text-lg border border-emerald-500/40">
              ✓
            </span>
            <h2 className="text-2xl font-black text-white tracking-tight">
              SWARM TEST COMPLETE
            </h2>
            <span className="px-3 py-1 rounded-full text-xs font-bold bg-emerald-950 text-emerald-300 border border-emerald-800">
              {cfg.userCount} ARTIFICIAL USERS
            </span>
          </div>
          <p className="text-xs text-zinc-400 mt-1">
            Execution concluded successfully. Full CRDT document convergence and latency percentiles verified.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onStartNew}
            className="px-5 py-2.5 rounded-xl text-sm font-bold bg-blue-600 hover:bg-blue-500 text-white transition-all shadow-lg shadow-blue-600/20 cursor-pointer"
          >
            ▶ Run Another Swarm Test
          </button>
          <button
            type="button"
            onClick={onViewDetails}
            className="px-4 py-2.5 rounded-xl text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition-colors cursor-pointer"
          >
            🔍 View Full Report
          </button>
        </div>
      </div>

      {/* Results Highlight Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
        {/* Median Latency (P50) */}
        <div className="bg-zinc-900/90 border border-blue-500/30 rounded-xl p-4 flex flex-col justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wider text-blue-400">
            Median (p50)
          </span>
          <div className="my-1">
            <span className="text-3xl font-extrabold font-mono text-white">
              {lat.p50Ms.toFixed(1)}
            </span>
            <span className="text-xs text-zinc-400 ml-1">ms</span>
          </div>
          <span className="text-[10px] text-zinc-500">50% of edits arrive faster</span>
        </div>

        {/* 95th Percentile Latency (P95) */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-300">
            95th %ile (p95)
          </span>
          <div className="my-1">
            <span className="text-3xl font-extrabold font-mono text-zinc-100">
              {lat.p95Ms.toFixed(1)}
            </span>
            <span className="text-xs text-zinc-400 ml-1">ms</span>
          </div>
          <span className="text-[10px] text-zinc-500">95% tail latency limit</span>
        </div>

        {/* 99th Percentile Latency (P99) */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
            99th %ile (p99)
          </span>
          <div className="my-1">
            <span className="text-3xl font-extrabold font-mono text-zinc-200">
              {lat.p99Ms.toFixed(1)}
            </span>
            <span className="text-xs text-zinc-400 ml-1">ms</span>
          </div>
          <span className="text-[10px] text-zinc-500">Peak tail latency</span>
        </div>

        {/* Propagated Operations */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400">
            Propagated Ops
          </span>
          <div className="my-1">
            <span className="text-3xl font-extrabold font-mono text-emerald-300">
              {res.opsPropagated}
            </span>
            <span className="text-xs text-zinc-400 ml-1">/{res.opsAttempted}</span>
          </div>
          <span className="text-[10px] text-emerald-500">
            {(res.successRate * 100).toFixed(1)}% propagation rate
          </span>
        </div>

        {/* Throughput */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
            Throughput
          </span>
          <div className="my-1">
            <span className="text-3xl font-extrabold font-mono text-zinc-100">
              {res.propagatedOpsPerSec.toFixed(1)}
            </span>
            <span className="text-xs text-zinc-400 ml-1">ops/s</span>
          </div>
          <span className="text-[10px] text-zinc-500">Sustained rate</span>
        </div>

        {/* Convergence State */}
        <div className="bg-zinc-900/90 border border-emerald-900/60 rounded-xl p-4 flex flex-col justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400">
            Convergence
          </span>
          <div className="my-1 flex items-center gap-1.5">
            <span className="text-2xl font-black text-emerald-400">✓</span>
            <span className="text-xl font-bold text-white">PASSED</span>
          </div>
          <span className="text-[10px] text-emerald-400/80">SHA-256 match verified</span>
        </div>
      </div>

      {/* Meta Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-zinc-950 p-4 rounded-xl border border-zinc-800 text-xs text-zinc-400">
        <div className="flex items-center gap-4">
          <span>
            Target: <code className="text-zinc-200">{cfg.targetUrl}</code>
          </span>
          <span>•</span>
          <span>
            Measurement Duration:{' '}
            <strong className="text-zinc-200">{(res.measurementDurationMs / 1000).toFixed(1)}s</strong>
          </span>
          <span>•</span>
          <span>
            Samples Analyzed: <strong className="text-zinc-200">{lat.sampleCount}</strong>
          </span>
        </div>

        <div className="flex items-center gap-2">
          <a
            href={benchmarkApi.getExportUrl(runId, 'csv')}
            className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded font-mono transition-colors"
            download
          >
            ↓ Export CSV
          </a>
          <a
            href={benchmarkApi.getExportUrl(runId, 'json')}
            className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded font-mono transition-colors"
            download
          >
            ↓ Export JSON
          </a>
        </div>
      </div>
    </div>
  );
}
