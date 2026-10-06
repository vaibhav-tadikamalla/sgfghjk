/**
 * admin/BenchmarkCharts.tsx
 *
 * Charts for comparing benchmark runs.
 * Uses plain SVG (no external chart library) to stay consistent with the
 * existing admin dashboard which builds charts without recharts.
 *
 * Charts:
 *   - Users vs p50 Latency
 *   - Users vs p95 Latency
 *   - Users vs Throughput (propagated ops/sec)
 *   - Users vs Success Rate
 */

import React from 'react';
import type { BenchmarkRun } from './benchmarkApi';

interface Props {
  runs: BenchmarkRun[];
}

interface ChartPoint {
  users: number;
  p50: number;
  p95: number;
  throughput: number;
  successRate: number;
}

function buildChartData(runs: BenchmarkRun[]): ChartPoint[] {
  const byUsers = new Map<number, ChartPoint>();
  for (const run of runs) {
    if (!run.results) continue;
    const u = run.config.userCount;
    const existing = byUsers.get(u);
    const point: ChartPoint = {
      users: u,
      p50: run.results.latency.p50Ms,
      p95: run.results.latency.p95Ms,
      throughput: run.results.propagatedOpsPerSec,
      successRate: Math.round(run.results.successRate * 10000) / 100,
    };
    if (!existing || existing.p50 > point.p50) {
      byUsers.set(u, point);
    }
  }
  return Array.from(byUsers.values()).sort((a, b) => a.users - b.users);
}

// ── SVG Bar Chart ─────────────────────────────────────────────────────────────

interface BarChartProps {
  title: string;
  data: ChartPoint[];
  getValue: (p: ChartPoint) => number;
  color: string;
  unit: string;
  formatValue?: (v: number) => string;
}

function BarChart({ title, data, getValue, color, unit, formatValue }: BarChartProps) {
  const W = 340;
  const H = 160;
  const PAD = { top: 10, right: 12, bottom: 30, left: 52 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const values = data.map(getValue);
  const maxVal = Math.max(...values, 0.001);

  const barW = data.length > 0 ? Math.max(4, Math.floor(innerW / data.length) - 4) : 20;
  const fmt = formatValue ?? ((v: number) => v.toFixed(1));

  const yTicks = 4;
  const yStep = maxVal / yTicks;

  return (
    <div>
      <p className="text-xs font-medium text-zinc-400 mb-1">{title}</p>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="overflow-visible">
        {/* Y axis gridlines */}
        {Array.from({ length: yTicks + 1 }, (_, i) => {
          const y = PAD.top + innerH - (i / yTicks) * innerH;
          const val = yStep * i;
          return (
            <g key={i}>
              <line x1={PAD.left} y1={y} x2={PAD.left + innerW} y2={y}
                stroke="#3f3f46" strokeDasharray="3 3" />
              <text x={PAD.left - 4} y={y} textAnchor="end" dominantBaseline="middle"
                fill="#71717a" fontSize={9}>
                {fmt(val)}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        {data.map((point, i) => {
          const val = getValue(point);
          const barH = (val / maxVal) * innerH;
          const spacing = innerW / data.length;
          const x = PAD.left + i * spacing + (spacing - barW) / 2;
          const y = PAD.top + innerH - barH;
          return (
            <g key={point.users}>
              <rect x={x} y={y} width={barW} height={barH} rx={2} fill={color} opacity={0.8} />
              {/* Value label on hover area (title tag) */}
              <title>{`${point.users} users: ${fmt(val)}${unit}`}</title>
              {/* X label */}
              <text x={x + barW / 2} y={PAD.top + innerH + 14}
                textAnchor="middle" fill="#71717a" fontSize={9}>
                {point.users}
              </text>
            </g>
          );
        })}

        {/* Axes */}
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + innerH}
          stroke="#52525b" />
        <line x1={PAD.left} y1={PAD.top + innerH} x2={PAD.left + innerW} y2={PAD.top + innerH}
          stroke="#52525b" />

        {/* X-axis label */}
        <text x={PAD.left + innerW / 2} y={H - 2} textAnchor="middle" fill="#52525b" fontSize={9}>
          Users
        </text>

        {/* Y-axis unit */}
        <text x={10} y={PAD.top + innerH / 2} textAnchor="middle" fill="#52525b" fontSize={9}
          transform={`rotate(-90, 10, ${PAD.top + innerH / 2})`}>
          {unit}
        </text>
      </svg>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function BenchmarkCharts({ runs }: Props) {
  const data = buildChartData(runs);

  if (data.length < 2) return null;

  return (
    <div className="bg-zinc-800/40 border border-zinc-700 rounded-lg p-5 space-y-4">
      <h3 className="text-sm font-semibold text-zinc-300">
        Benchmark Charts
        <span className="ml-2 text-xs font-normal text-zinc-500">({data.length} data points)</span>
      </h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <BarChart
          title="p50 Latency vs Users"
          data={data}
          getValue={p => p.p50}
          color="#60a5fa"
          unit=" ms"
          formatValue={v => `${v.toFixed(1)}ms`}
        />
        <BarChart
          title="p95 Latency vs Users"
          data={data}
          getValue={p => p.p95}
          color="#a78bfa"
          unit=" ms"
          formatValue={v => `${v.toFixed(1)}ms`}
        />
        <BarChart
          title="Throughput vs Users"
          data={data}
          getValue={p => p.throughput}
          color="#34d399"
          unit=" ops/s"
          formatValue={v => `${v.toFixed(2)}`}
        />
        <BarChart
          title="Success Rate vs Users"
          data={data}
          getValue={p => p.successRate}
          color="#fbbf24"
          unit="%"
          formatValue={v => `${v.toFixed(1)}%`}
        />
      </div>

      <p className="text-[10px] text-zinc-600">
        Hover bars to see values. One bar per unique userCount — lowest p50 wins when multiple runs share the same count.
      </p>
    </div>
  );
}
