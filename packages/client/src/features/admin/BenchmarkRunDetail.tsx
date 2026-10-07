/**
 * admin/BenchmarkRunDetail.tsx
 *
 * Expanded detail panel for a single selected benchmark run.
 * Shows full config, all latency percentiles, operation stats, resource metrics, and convergence.
 */

import React from 'react';
import { useBenchmarkRun } from './benchmarkHooks';
import { benchmarkApi } from './benchmarkApi';

interface Props {
  runId: string;
  onClose: () => void;
}

function fmtMs(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1000) return `${n.toFixed(2)} ms`;
  return `${(n / 1000).toFixed(3)} s`;
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${(n * 100).toFixed(2)}%`;
}

export function BenchmarkRunDetail({ runId, onClose }: Props) {
  const { data: run, isLoading } = useBenchmarkRun(runId);

  if (isLoading) {
    return (
      <div className="bg-zinc-800/40 border border-zinc-700 rounded-lg p-6 text-center text-zinc-500 text-sm">
        Loading run details…
      </div>
    );
  }

  if (!run) return null;

  const cfg = run.config;
  const res = run.results;

  return (
    <div className="bg-zinc-800/60 border border-blue-700/40 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-700 bg-zinc-800">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">
            Run <code className="text-blue-300">{runId.slice(0, 8)}</code>
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            {new Date(run.created_at).toLocaleString()} · {run.status} · {cfg.userCount} users · {run.environment?.['source'] === 'external-cli' ? 'External CLI (end-to-end)' : (cfg.benchmarkMode === 'load' ? 'Load test mode' : 'Latency mode (t₁→t₂)')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {res && (
            <>
              <a
                href={benchmarkApi.getExportUrl(runId, 'csv')}
                className="text-xs px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded transition-colors"
                download
              >
                ↓ CSV
              </a>
              <a
                href={benchmarkApi.getExportUrl(runId, 'json')}
                className="text-xs px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded transition-colors"
                download
              >
                ↓ JSON
              </a>
            </>
          )}
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-sm px-2">✕</button>
        </div>
      </div>

      <div className="p-5 space-y-5">
        {/* Error */}
        {run.error_message && (
          <div className="bg-red-900/20 border border-red-800 rounded p-3 text-xs text-red-300">
            {run.error_message}
          </div>
        )}

        {/* No results yet */}
        {!res && run.status !== 'failed' && (
          <p className="text-xs text-zinc-500 italic">Results not yet available (run may still be in progress).</p>
        )}

        {res && (
          <>
            {/* Primary latency stats */}
            <section>
              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                Propagation Latency
                <span className="ml-1.5 text-zinc-600 normal-case">(t₁→t₂, n={res.latency.sampleCount.toLocaleString()} samples)</span>
              </h4>
              <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
                {[
                  ['Min', fmtMs(res.latency.minMs), 'text-zinc-300'],
                  ['Mean', fmtMs(res.latency.meanMs), 'text-zinc-300'],
                  ['p50', fmtMs(res.latency.p50Ms), 'text-blue-300'],
                  ['p90', fmtMs(res.latency.p90Ms), 'text-indigo-300'],
                  ['p95', fmtMs(res.latency.p95Ms), 'text-violet-300'],
                  ['p99', fmtMs(res.latency.p99Ms), 'text-rose-300'],
                  ['Max', fmtMs(res.latency.maxMs), 'text-zinc-400'],
                  ['Std Dev', fmtMs(res.latency.stddevMs), 'text-zinc-400'],
                ].map(([label, value, cls]) => (
                  <div key={label as string} className="bg-zinc-900/60 rounded p-2">
                    <p className="text-[10px] text-zinc-500">{label}</p>
                    <p className={`text-sm font-mono font-semibold ${cls}`}>{value}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Operations */}
            <section>
              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Operations</h4>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {[
                  ['Attempted', res.opsAttempted.toLocaleString(), 'text-zinc-300'],
                  ['Propagated', res.opsPropagated.toLocaleString(), 'text-green-400'],
                  ['Timed Out', res.opsTimedOut.toLocaleString(), 'text-amber-400'],
                  ['Success Rate', fmtPct(res.successRate), 'text-green-400'],
                  ['Ops/s (prop.)', res.propagatedOpsPerSec.toFixed(2), 'text-blue-300'],
                  ['Ops/s (att.)', res.attemptedOpsPerSec.toFixed(2), 'text-zinc-400'],
                ].map(([label, value, cls]) => (
                  <div key={label as string} className="bg-zinc-900/60 rounded p-2">
                    <p className="text-[10px] text-zinc-500">{label}</p>
                    <p className={`text-sm font-mono font-semibold ${cls}`}>{value}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Connections */}
            <section>
              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Connections</h4>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ['Attempts', res.connectionAttempts],
                  ['Successes', res.connectionSuccesses],
                  ['Failures', res.connectionFailures],
                ].map(([label, value]) => (
                  <div key={label as string} className="bg-zinc-900/60 rounded p-2">
                    <p className="text-[10px] text-zinc-500">{label}</p>
                    <p className="text-sm font-mono font-semibold text-zinc-300">{value}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Convergence */}
            <section>
              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Convergence</h4>
              <div className="flex items-center gap-3">
                <span className={`text-sm font-semibold ${res.convergenceAchieved ? 'text-green-400' : 'text-red-400'}`}>
                  {res.convergenceAchieved ? '✓ Converged' : '✗ Not Converged'}
                </span>
                {res.convergenceTimeMs != null && (
                  <span className="text-xs text-zinc-500">
                    in ~{(res.convergenceTimeMs / 1000).toFixed(1)}s after measurement phase
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-600 mt-1">
                All {res.convergenceFingerprints.length} editors' Y.Doc SHA-256 hashes{' '}
                {res.convergenceAchieved ? 'matched.' : 'DID NOT match.'}
              </p>
            </section>

            {/* Resource metrics */}
            <section>
              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                Resource Metrics
                <span className="ml-1.5 text-zinc-600 normal-case">(PeerGrid server process)</span>
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  ['Heap at Start', fmtBytes(res.processMemoryAtStartBytes)],
                  ['Heap Peak', fmtBytes(res.processMemoryPeakBytes)],
                  ['CPU User', res.processCpuUserMsTotal != null ? `${res.processCpuUserMsTotal}ms` : '—'],
                  ['CPU System', res.processCpuSystemMsTotal != null ? `${res.processCpuSystemMsTotal}ms` : '—'],
                ].map(([label, value]) => (
                  <div key={label as string} className="bg-zinc-900/60 rounded p-2">
                    <p className="text-[10px] text-zinc-500">{label}</p>
                    <p className="text-sm font-mono text-zinc-300">{value}</p>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}

        {/* Config */}
        <section>
          <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Config</h4>
          <div className="bg-zinc-900/60 rounded p-3 text-xs font-mono text-zinc-400 whitespace-pre overflow-x-auto">
            {JSON.stringify(cfg, null, 2)}
          </div>
        </section>
      </div>
    </div>
  );
}
