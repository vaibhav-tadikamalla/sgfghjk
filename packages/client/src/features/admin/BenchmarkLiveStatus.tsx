/**
 * admin/BenchmarkLiveStatus.tsx
 *
 * Live status banner shown while a benchmark is running.
 * Updates every 2 seconds via React Query polling.
 */

import React from 'react';
import type { BenchmarkLiveStatus as LiveStatus } from './benchmarkApi';

const PHASE_LABELS: Record<string, string> = {
  warmup: 'Warm-up',
  measurement: 'Measuring',
  cooldown: 'Cooldown',
  convergence: 'Convergence check',
  persisting: 'Saving results',
};

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

interface Props {
  status: LiveStatus;
}

export function BenchmarkLiveStatus({ status }: Props) {
  const label = PHASE_LABELS[status.phase] ?? status.phase;

  return (
    <div className="bg-amber-900/20 border border-amber-700/50 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-amber-400 rounded-full animate-pulse" />
          <span className="text-sm font-medium text-amber-300">{label}</span>
          <span className="text-xs text-amber-500">
            (phase elapsed: {fmtDuration(status.phaseElapsedMs)})
          </span>
        </div>
        <span className="text-xs text-zinc-500">
          Total elapsed: {fmtDuration(status.elapsedMs)}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Stat label="Active Editors" value={status.activeEditors.toString()} />
        <Stat label="Samples" value={status.samplesCollected.toLocaleString()} />
        <Stat
          label="Live p50"
          value={status.liveP50Ms > 0 ? fmtMs(status.liveP50Ms) : '—'}
          highlight={status.liveP50Ms > 0}
        />
        <Stat
          label="Live p95"
          value={status.liveP95Ms > 0 ? fmtMs(status.liveP95Ms) : '—'}
          highlight={status.liveP95Ms > 0}
        />
      </div>

      {status.config && (
        <p className="mt-3 text-xs text-zinc-500">
          {status.config.userCount} users ·{' '}
          {status.config.durationSeconds}s measurement ·{' '}
          {status.config.typingSpeed ?? 2} chars/s ·{' '}
          <code className="text-zinc-400">{status.config.targetUrl}</code>
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`text-lg font-mono font-semibold ${highlight ? 'text-amber-300' : 'text-zinc-200'}`}>
        {value}
      </p>
    </div>
  );
}
