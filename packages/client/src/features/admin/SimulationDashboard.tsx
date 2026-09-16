import React, { useRef, useEffect } from 'react';
import type { SimulationSnapshot, SimulatedEditorMetrics } from './api';

interface Props {
  snapshot: SimulationSnapshot;
}

const fmtNum = (n: number) => n.toLocaleString();
const fmtMs = (ms: number) => {
  if (ms < 1_000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec % 60}s`;
};

export function SimulationDashboard({ snapshot }: Props) {
  const isActive = snapshot.state === 'running' || snapshot.state === 'starting';

  return (
    <div className="space-y-5">
      {/* Summary KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label="Editors Active"
          value={snapshot.editors.editing + snapshot.editors.idle}
          sub={`/ ${snapshot.editors.total} total`}
          accent="blue"
        />
        <KpiCard
          label="Edits / sec"
          value={snapshot.metrics.editsPerSecond.toFixed(1)}
          sub={`${fmtNum(snapshot.metrics.totalEditsGenerated)} total`}
          accent="green"
        />
        <KpiCard
          label="Avg Latency"
          value={`${snapshot.metrics.averageLatencyMs.toFixed(0)}ms`}
          sub={snapshot.metrics.averageLatencyMs < 50 ? 'Excellent' : snapshot.metrics.averageLatencyMs < 150 ? 'Good' : 'Degraded'}
          accent={snapshot.metrics.averageLatencyMs < 50 ? 'green' : snapshot.metrics.averageLatencyMs < 150 ? 'yellow' : 'red'}
        />
        <KpiCard
          label="Failures"
          value={snapshot.metrics.totalConnectionFailures}
          sub={`${snapshot.metrics.totalReconnects} reconnects`}
          accent={snapshot.metrics.totalConnectionFailures > 0 ? 'red' : 'green'}
        />
      </div>

      {/* Elapsed time */}
      {snapshot.startedAt && (
        <div className="text-xs text-zinc-500 flex items-center gap-2">
          <span>Elapsed: {fmtMs(snapshot.elapsedMs)}</span>
          {isActive && <span className="inline-block w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />}
        </div>
      )}

      {/* Editor state distribution bar */}
      <EditorStateBar editors={snapshot.editors} />

      {/* Editor table (top 50) */}
      {snapshot.editorDetails.length > 0 && (
        <EditorDetailsTable editors={snapshot.editorDetails} />
      )}
    </div>
  );
}

/* ── KPI Card ── */

const ACCENT_COLORS: Record<string, string> = {
  blue: 'text-blue-400',
  green: 'text-green-400',
  yellow: 'text-yellow-400',
  red: 'text-red-400',
};

function KpiCard({ label, value, sub, accent }: { label: string; value: string | number; sub: string; accent: string }) {
  return (
    <div className="bg-zinc-800/60 border border-zinc-700 rounded-lg p-4">
      <div className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${ACCENT_COLORS[accent] ?? 'text-zinc-200'}`}>{value}</div>
      <div className="text-xs text-zinc-500 mt-0.5">{sub}</div>
    </div>
  );
}

/* ── Editor state distribution ── */

interface EditorBuckets {
  total: number;
  connecting: number;
  authenticating: number;
  syncing: number;
  editing: number;
  idle: number;
  reconnecting: number;
  stopped: number;
}

const STATE_COLORS: Record<string, string> = {
  connecting: 'bg-yellow-500',
  authenticating: 'bg-yellow-600',
  syncing: 'bg-blue-500',
  editing: 'bg-green-500',
  idle: 'bg-zinc-500',
  reconnecting: 'bg-orange-500',
  stopped: 'bg-red-500',
};

const STATE_ORDER: (keyof Omit<EditorBuckets, 'total'>)[] = [
  'editing', 'idle', 'syncing', 'connecting', 'authenticating', 'reconnecting', 'stopped',
];

function EditorStateBar({ editors }: { editors: EditorBuckets }) {
  if (editors.total === 0) return null;

  return (
    <div className="bg-zinc-800/60 border border-zinc-700 rounded-lg p-4 space-y-3">
      <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Editor State Distribution</h3>

      {/* Stacked bar */}
      <div className="h-5 rounded-md overflow-hidden flex" title={`${editors.total} total editors`}>
        {STATE_ORDER.map(key => {
          const count = editors[key];
          if (count === 0) return null;
          const pct = (count / editors.total) * 100;
          return (
            <div
              key={key}
              className={`${STATE_COLORS[key]} transition-all duration-500`}
              style={{ width: `${pct}%` }}
              title={`${key}: ${count} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-400">
        {STATE_ORDER.map(key => {
          const count = editors[key];
          if (count === 0) return null;
          return (
            <span key={key} className="flex items-center gap-1.5">
              <span className={`inline-block w-2.5 h-2.5 rounded-sm ${STATE_COLORS[key]}`} />
              {key} <span className="text-zinc-500">({count})</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ── Per-editor table ── */

function EditorDetailsTable({ editors }: { editors: SimulatedEditorMetrics[] }) {
  const STATE_DOT: Record<string, string> = {
    connecting: 'bg-yellow-400',
    authenticating: 'bg-yellow-500',
    syncing: 'bg-blue-400',
    editing: 'bg-green-400',
    idle: 'bg-zinc-400',
    reconnecting: 'bg-orange-400',
    stopped: 'bg-red-400',
  };

  return (
    <div className="bg-zinc-800/60 border border-zinc-700 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-700">
        <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
          Editor Details <span className="text-zinc-500">(top {editors.length})</span>
        </h3>
      </div>
      <div className="overflow-x-auto max-h-80 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-zinc-900/60 sticky top-0">
            <tr className="text-zinc-500 uppercase tracking-wider">
              <th className="px-4 py-2 text-left">Editor</th>
              <th className="px-4 py-2 text-left">State</th>
              <th className="px-4 py-2 text-right">Edits</th>
              <th className="px-4 py-2 text-right">Awareness</th>
              <th className="px-4 py-2 text-right">Reconnects</th>
              <th className="px-4 py-2 text-right">Failures</th>
              <th className="px-4 py-2 text-right">Latency</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-700/50">
            {editors.map(ed => (
              <tr key={ed.editorId} className="hover:bg-zinc-700/20 transition-colors">
                <td className="px-4 py-2 font-mono text-zinc-300">{ed.editorId.slice(0, 12)}</td>
                <td className="px-4 py-2">
                  <span className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${STATE_DOT[ed.state] ?? 'bg-zinc-500'}`} />
                    <span className="text-zinc-300">{ed.state}</span>
                  </span>
                </td>
                <td className="px-4 py-2 text-right text-zinc-300">{ed.editsGenerated}</td>
                <td className="px-4 py-2 text-right text-zinc-400">{ed.awarenessUpdates}</td>
                <td className="px-4 py-2 text-right text-zinc-400">{ed.reconnects}</td>
                <td className={`px-4 py-2 text-right ${ed.connectionFailures > 0 ? 'text-red-400' : 'text-zinc-400'}`}>
                  {ed.connectionFailures}
                </td>
                <td className={`px-4 py-2 text-right ${
                  ed.latencyMs < 50 ? 'text-green-400' : ed.latencyMs < 150 ? 'text-yellow-400' : 'text-red-400'
                }`}>
                  {ed.latencyMs.toFixed(0)}ms
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
