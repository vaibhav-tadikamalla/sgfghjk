/**
 * admin/BenchmarkRunHistory.tsx
 *
 * Sortable table of all benchmark runs. Click a row to select it for detail view.
 */

import React from 'react';
import type { BenchmarkRun } from './benchmarkApi';
import { useDeleteBenchmarkRun } from './benchmarkHooks';

interface Props {
  runs: BenchmarkRun[];
  total: number;
  selectedRunId: string | null;
  onSelect: (id: string) => void;
}

const STATUS_STYLES: Record<string, string> = {
  queued:    'bg-zinc-700 text-zinc-300',
  running:   'bg-amber-900/60 text-amber-300 animate-pulse',
  completed: 'bg-green-900/50 text-green-400',
  failed:    'bg-red-900/50 text-red-400',
  cancelled: 'bg-zinc-700 text-zinc-500',
};

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function BenchmarkRunHistory({ runs, total, selectedRunId, onSelect }: Props) {
  const del = useDeleteBenchmarkRun();

  if (runs.length === 0) {
    return (
      <div className="bg-zinc-800/40 border border-zinc-700 rounded-lg p-6 text-center text-sm text-zinc-500">
        No benchmark runs yet. Configure and start one above.
      </div>
    );
  }

  return (
    <div className="bg-zinc-800/40 border border-zinc-700 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-300">
          Run History <span className="text-zinc-500 font-normal">({total} total)</span>
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-zinc-700 text-zinc-500">
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-left font-medium">Started</th>
              <th className="px-3 py-2 text-right font-medium">Users</th>
              <th className="px-3 py-2 text-right font-medium">Duration</th>
              <th className="px-3 py-2 text-right font-medium">Samples</th>
              <th className="px-3 py-2 text-right font-medium">p50</th>
              <th className="px-3 py-2 text-right font-medium">p95</th>
              <th className="px-3 py-2 text-right font-medium">Ops/s</th>
              <th className="px-3 py-2 text-center font-medium">Conv.</th>
              <th className="px-3 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {runs.map(run => {
              const cfg = run.config;
              const res = run.results;
              const isSelected = run.id === selectedRunId;
              return (
                <tr
                  key={run.id}
                  onClick={() => onSelect(run.id)}
                  className={`border-b border-zinc-700/50 cursor-pointer transition-colors ${
                    isSelected ? 'bg-blue-900/20' : 'hover:bg-zinc-700/30'
                  }`}
                >
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_STYLES[run.status] ?? ''}`}>
                      {run.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-zinc-400 whitespace-nowrap">
                    {fmtDate(run.started_at ?? run.created_at)}
                  </td>
                  <td className="px-3 py-2 text-right text-zinc-300 font-mono">
                    {cfg.userCount}
                  </td>
                  <td className="px-3 py-2 text-right text-zinc-400">
                    {res ? `${(res.measurementDurationMs / 1000).toFixed(0)}s` : `${cfg.durationSeconds}s`}
                  </td>
                  <td className="px-3 py-2 text-right text-zinc-400 font-mono">
                    {res ? res.latency.sampleCount.toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-blue-300 font-mono font-medium">
                    {res ? fmtMs(res.latency.p50Ms) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-violet-300 font-mono font-medium">
                    {res ? fmtMs(res.latency.p95Ms) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-zinc-300 font-mono">
                    {res ? res.propagatedOpsPerSec.toFixed(1) : '—'}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {res == null ? '—' : res.convergenceAchieved
                      ? <span className="text-green-400">✓</span>
                      : <span className="text-red-400">✗</span>
                    }
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); del.mutate(run.id); }}
                      className="text-zinc-600 hover:text-red-400 transition-colors"
                      title="Delete run"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
