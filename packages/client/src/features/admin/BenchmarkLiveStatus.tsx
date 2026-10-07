/**
 * admin/BenchmarkLiveStatus.tsx
 *
 * Full-screen live visualization of PeerGrid's collaborative swarm test.
 * Displays:
 *   1. Connected artificial users (10 / 10 connected)
 *   2. Phase stepper & progress bar (Warmup → Measurement → Cooldown → Convergence)
 *   3. Prominent Live Propagation Latency (P50, P95, P99, Latest)
 *   4. Live Rolling SVG Latency Sparkline
 *   5. Operations generated vs propagated and live throughput (updates/sec)
 *   6. CRDT state convergence indicator
 *   7. Interactive simulated users grid showing per-user active state & edit count
 */

import React from 'react';
import type { BenchmarkLiveStatus as LiveStatus } from './benchmarkApi';
import { useCancelBenchmark } from './benchmarkHooks';

interface Props {
  status: LiveStatus;
}

const PHASES = [
  { id: 'warmup', label: '1. Warm-up', desc: 'Syncing clients' },
  { id: 'measurement', label: '2. Measurement', desc: 'Sampling t₁→t₂' },
  { id: 'cooldown', label: '3. Cooldown', desc: 'Settling in-flight' },
  { id: 'convergence', label: '4. Convergence', desc: 'Verifying CRDT' },
];

function fmtMs(ms: number | null | undefined): string {
  if (ms == null || ms === 0) return '—';
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtSec(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

export function BenchmarkLiveStatus({ status }: Props) {
  const cancel = useCancelBenchmark();

  const totalUsers = status.config?.userCount ?? status.totalExpectedUsers ?? 10;
  const connectedUsers = status.activeEditors;
  const progressPct = status.progressPercent ?? 0;
  const currentPhase = status.phase;

  // Determine active step index for progress stepper
  const phaseIndex = ['warmup', 'measurement', 'cooldown', 'convergence', 'persisting'].indexOf(currentPhase);

  return (
    <div className="bg-zinc-900 border-2 border-blue-500/40 rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6">
      {/* ── Top Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-5">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <span className="relative flex h-3.5 w-3.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-blue-500" />
            </span>
            <h2 className="text-xl font-extrabold text-white tracking-tight">
              SWARM TEST IN PROGRESS
            </h2>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-950 text-blue-300 border border-blue-800">
              {totalUsers} SIMULATED USERS
            </span>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-300 border border-emerald-800">
              {status.config?.benchmarkMode === 'load' ? 'LOAD MODE' : 'LATENCY MODE (t₁→t₂)'}
            </span>
          </div>
          <p className="text-xs text-zinc-400">
            Measuring real-time edit propagation from artificial participants to document convergence.
          </p>
        </div>

        <button
          type="button"
          onClick={() => cancel.mutate()}
          disabled={cancel.isPending}
          className="self-start sm:self-auto px-4 py-2 text-xs font-bold uppercase tracking-wider text-red-200 bg-red-950/80 hover:bg-red-900 border border-red-700/60 rounded-lg transition-colors cursor-pointer"
        >
          {cancel.isPending ? 'Cancelling…' : '✕ Abort Test'}
        </button>
      </div>

      {/* ── Phase Stepper & Progress Bar ────────────────────────────────────── */}
      <div className="bg-zinc-950/70 border border-zinc-800 rounded-xl p-5 space-y-4">
        {/* Phase steps */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {PHASES.map((p, idx) => {
            const isCurrent = p.id === currentPhase;
            const isCompleted = phaseIndex > idx;
            return (
              <div
                key={p.id}
                className={`p-3 rounded-lg border transition-all ${
                  isCurrent
                    ? 'bg-blue-900/30 border-blue-500 shadow-md shadow-blue-500/10'
                    : isCompleted
                    ? 'bg-zinc-900/40 border-zinc-700/50 text-zinc-400'
                    : 'bg-zinc-900/20 border-zinc-800 text-zinc-600'
                }`}
              >
                <div className="flex items-center justify-between text-xs font-bold mb-1">
                  <span className={isCurrent ? 'text-blue-300' : isCompleted ? 'text-zinc-300' : 'text-zinc-500'}>
                    {p.label}
                  </span>
                  {isCurrent && <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />}
                  {isCompleted && <span className="text-emerald-400">✓</span>}
                </div>
                <div className="text-[11px] text-zinc-400 truncate">{p.desc}</div>
              </div>
            );
          })}
        </div>

        {/* Progress Bar */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span className="font-semibold text-zinc-300">Overall Progress</span>
            <div className="flex items-center gap-3 text-xs font-mono">
              <span>Elapsed: <strong className="text-white">{fmtSec(status.elapsedMs)}</strong></span>
              <span>•</span>
              <span>Remaining: <strong className="text-blue-400">{fmtSec(status.remainingMs)}</strong></span>
              <span>•</span>
              <span className="font-bold text-white">{progressPct}%</span>
            </div>
          </div>
          <div className="w-full h-3 bg-zinc-800 rounded-full overflow-hidden p-0.5 border border-zinc-700/50">
            <div
              className="h-full bg-gradient-to-r from-blue-600 via-indigo-500 to-emerald-500 rounded-full transition-all duration-500 ease-out"
              style={{ width: `${Math.max(2, Math.min(100, progressPct))}%` }}
            />
          </div>
        </div>
      </div>

      {/* ── Key Metrics Grid ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Card 1: Live Propagation Latency */}
        <div className="lg:col-span-2 bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950 border border-blue-500/30 rounded-xl p-5 shadow-lg space-y-4">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-blue-400">
                Primary Metric
              </span>
              <h3 className="text-base font-bold text-white">Live Edit Propagation Latency</h3>
            </div>
            <div className="text-right">
              <span className="text-xs text-zinc-400">Samples Collected</span>
              <p className="text-sm font-mono font-bold text-zinc-200">
                {status.samplesCollected.toLocaleString()}
              </p>
            </div>
          </div>

          {/* Primary Numbers */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
            <div className="bg-zinc-900/80 p-3 rounded-lg border border-blue-500/20">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                Median (p50)
              </span>
              <div className="text-3xl font-extrabold font-mono text-blue-400 mt-0.5">
                {status.liveP50Ms > 0 ? `${status.liveP50Ms}` : '—'}
                <span className="text-sm font-normal text-zinc-400 ml-1">ms</span>
              </div>
            </div>

            <div className="bg-zinc-900/80 p-3 rounded-lg border border-zinc-800">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                95th %ile (p95)
              </span>
              <div className="text-2xl font-bold font-mono text-indigo-300 mt-1">
                {status.liveP95Ms > 0 ? `${status.liveP95Ms}` : '—'}
                <span className="text-xs font-normal text-zinc-400 ml-1">ms</span>
              </div>
            </div>

            <div className="bg-zinc-900/80 p-3 rounded-lg border border-zinc-800">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                99th %ile (p99)
              </span>
              <div className="text-2xl font-bold font-mono text-zinc-200 mt-1">
                {status.liveP99Ms > 0 ? `${status.liveP99Ms}` : '—'}
                <span className="text-xs font-normal text-zinc-400 ml-1">ms</span>
              </div>
            </div>

            <div className="bg-zinc-900/80 p-3 rounded-lg border border-zinc-800">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                Latest Sample
              </span>
              <div className="text-2xl font-bold font-mono text-emerald-400 mt-1">
                {status.latestLatencyMs > 0 ? `${status.latestLatencyMs}` : '—'}
                <span className="text-xs font-normal text-zinc-400 ml-1">ms</span>
              </div>
            </div>
          </div>

          {/* Rolling Sparkline */}
          <div className="pt-2">
            <div className="flex items-center justify-between text-xs text-zinc-400 mb-2">
              <span className="font-semibold text-zinc-300">Live Rolling Latency Stream</span>
              <span className="text-[11px]">Recent propagation times ($t_1 \to t_2$)</span>
            </div>
            <LatencyStreamSparkline samples={status.recentLatencies ?? []} />
          </div>
        </div>

        {/* Card 2: Swarm Activity & Convergence */}
        <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-5 shadow-lg flex flex-col justify-between space-y-4">
          <div>
            <div className="border-b border-zinc-800 pb-3 mb-4">
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                System Activity
              </span>
              <h3 className="text-base font-bold text-white">Live Swarm Throughput</h3>
            </div>

            <div className="space-y-3.5">
              {/* Connected Users */}
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-900/70 border border-zinc-800">
                <span className="text-xs text-zinc-300">Active Connections</span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold font-mono bg-emerald-950 text-emerald-300 border border-emerald-800">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  {connectedUsers} / {totalUsers} Connected
                </span>
              </div>

              {/* Ops Generated */}
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-900/70 border border-zinc-800">
                <span className="text-xs text-zinc-300">Edits Generated</span>
                <span className="text-sm font-mono font-bold text-white">
                  {(status.opsAttempted ?? 0).toLocaleString()} ops
                </span>
              </div>

              {/* Ops Propagated */}
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-900/70 border border-zinc-800">
                <span className="text-xs text-zinc-300">Propagated & Applied</span>
                <span className="text-sm font-mono font-bold text-blue-400">
                  {(status.opsPropagated ?? status.samplesCollected ?? 0).toLocaleString()} ops
                </span>
              </div>

              {/* Throughput */}
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-900/70 border border-zinc-800">
                <span className="text-xs text-zinc-300">Throughput Rate</span>
                <span className="text-sm font-mono font-bold text-indigo-300">
                  {status.editsPerSecond.toFixed(1)} ops/sec
                </span>
              </div>
            </div>
          </div>

          {/* Convergence Status */}
          <div className="p-3.5 rounded-lg bg-zinc-900 border border-zinc-800">
            <span className="text-[10px] uppercase font-bold tracking-wider text-zinc-400 block mb-1">
              CRDT Eventual Consistency
            </span>
            <div className="flex items-center gap-2">
              {currentPhase === 'cooldown' || currentPhase === 'convergence' ? (
                <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                  <span>Settling in-flight operations…</span>
                </div>
              ) : currentPhase === 'completed' ? (
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
                  <span className="text-base">✓</span>
                  <span>Converged: All state vectors match</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs font-semibold text-blue-400">
                  <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                  <span>Synchronizing live document states…</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Simulated Users Swarm Grid (Phase 6) ─────────────────────────────── */}
      <div className="bg-zinc-950 border border-zinc-800/80 rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between border-b border-zinc-800/70 pb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-zinc-300">
              Active Artificial Participants
            </span>
            <span className="text-xs text-zinc-500">
              ({connectedUsers} / {totalUsers} generating real collaborative edits)
            </span>
          </div>
          <span className="text-[11px] text-zinc-400 font-mono">
            Target: <code className="text-blue-300">{status.config?.targetUrl ?? 'localhost:3001'}</code>
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
          {status.simulatedUsers && status.simulatedUsers.length > 0 ? (
            status.simulatedUsers.map((user, idx) => (
              <div
                key={user.editorId || idx}
                className={`p-2.5 rounded-lg border text-xs flex flex-col justify-between transition-all ${
                  user.isConnected
                    ? 'bg-zinc-900/90 border-emerald-900/60 shadow-sm'
                    : 'bg-zinc-900/30 border-zinc-800 text-zinc-500'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-white flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${user.isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-red-500'}`} />
                    User {String(idx + 1).padStart(2, '0')}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-300 font-mono">
                    {user.isConnected ? 'ONLINE' : 'CONNECTING'}
                  </span>
                </div>
                <div className="text-[11px] text-zinc-400 flex items-center justify-between font-mono">
                  <span>Edits:</span>
                  <strong className="text-zinc-200">{user.editsCount}</strong>
                </div>
              </div>
            ))
          ) : (
            // Fallback user grid based on expected total
            Array.from({ length: totalUsers }).map((_, idx) => (
              <div
                key={idx}
                className="p-2.5 rounded-lg border bg-zinc-900/60 border-zinc-800 text-xs flex flex-col justify-between"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-white flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                    User {String(idx + 1).padStart(2, '0')}
                  </span>
                  <span className="text-[10px] text-emerald-400">ACTIVE</span>
                </div>
                <div className="text-[11px] text-zinc-400">Generating operations…</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ── SVG Sparkline for Real-time Latency Stream ────────────────────────────────

function LatencyStreamSparkline({ samples }: { samples: number[] }) {
  if (samples.length === 0) {
    return (
      <div className="h-28 rounded-lg bg-zinc-900/40 border border-zinc-800/60 flex items-center justify-center text-xs text-zinc-500">
        Waiting for latency samples in measurement phase…
      </div>
    );
  }

  const W = 600;
  const H = 110;
  const PAD = { top: 12, right: 20, bottom: 20, left: 40 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const minVal = Math.max(0, Math.min(...samples) * 0.85);
  const maxVal = Math.max(...samples, 10) * 1.15;
  const range = maxVal - minVal || 1;

  const points = samples.map((v, i) => {
    const x = PAD.left + (samples.length === 1 ? innerW / 2 : (i / (samples.length - 1)) * innerW);
    const y = PAD.top + innerH - ((v - minVal) / range) * innerH;
    return { x, y, v };
  });

  const pathD = points.reduce((acc, p, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)},${p.y.toFixed(1)}`, '');
  const areaD = `${pathD} L ${points[points.length - 1]!.x.toFixed(1)},${PAD.top + innerH} L ${points[0]!.x.toFixed(1)},${PAD.top + innerH} Z`;

  return (
    <div className="w-full bg-zinc-900/50 rounded-lg p-2 border border-zinc-800">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={110} className="overflow-visible">
        {/* Horizontal gridlines */}
        {[0, 0.5, 1].map((pct, idx) => {
          const y = PAD.top + innerH * (1 - pct);
          const val = minVal + range * pct;
          return (
            <g key={idx}>
              <line x1={PAD.left} y1={y} x2={PAD.left + innerW} y2={y} stroke="#27272a" strokeDasharray="3 3" />
              <text x={PAD.left - 6} y={y + 3} textAnchor="end" fill="#71717a" fontSize={9} fontFamily="monospace">
                {Math.round(val)}ms
              </text>
            </g>
          );
        })}

        {/* Fill Area */}
        <path d={areaD} fill="url(#latencyGrad)" opacity={0.3} />

        {/* Line */}
        <path d={pathD} fill="none" stroke="#60a5fa" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />

        {/* Data points */}
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={i === points.length - 1 ? 4.5 : 2.5}
            fill={i === points.length - 1 ? '#93c5fd' : '#3b82f6'}
            stroke="#1e293b"
            strokeWidth={1.5}
          />
        ))}

        {/* Gradient definition */}
        <defs>
          <linearGradient id="latencyGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}
