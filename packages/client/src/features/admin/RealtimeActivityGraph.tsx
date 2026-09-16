import React from 'react';
import type { ActivityHistoryResponse } from './api';

interface Props {
  history: ActivityHistoryResponse;
}

/**
 * Realtime Activity Graph — sparkline-style time-series visualization.
 * Tracks edits/min, connections, and active rooms over a 5-minute window.
 * Uses pure CSS/SVG — no charting library required.
 */
export function RealtimeActivityGraph({ history }: Props) {
  const { samples } = history;

  if (samples.length < 2) {
    return (
      <div className="bg-zinc-800 rounded-lg border border-zinc-700 p-8 text-center text-sm text-zinc-500">
        Collecting data… ({samples.length} sample{samples.length !== 1 ? 's' : ''} so far, need at least 2)
      </div>
    );
  }

  return (
    <div className="bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-700 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Realtime Activity</h3>
        <span className="text-xs text-zinc-500">
          {samples.length} samples &middot; {Math.round((samples.length * history.sampleIntervalMs) / 1000)}s window
        </span>
      </div>

      <div className="p-4 grid gap-4 md:grid-cols-2">
        <Sparkline
          label="Edits / min"
          data={samples.map(s => s.editsPerMinute)}
          timestamps={samples.map(s => s.ts)}
          color="#818cf8" /* indigo-400 */
          fillColor="rgba(129, 140, 248, 0.15)"
        />
        <Sparkline
          label="WebSocket Connections"
          data={samples.map(s => s.connections)}
          timestamps={samples.map(s => s.ts)}
          color="#34d399" /* emerald-400 */
          fillColor="rgba(52, 211, 153, 0.15)"
        />
        <Sparkline
          label="Active Rooms"
          data={samples.map(s => s.activeRooms)}
          timestamps={samples.map(s => s.ts)}
          color="#fbbf24" /* amber-400 */
          fillColor="rgba(251, 191, 36, 0.15)"
        />
        <Sparkline
          label="Editors"
          data={samples.map(s => s.editors)}
          timestamps={samples.map(s => s.ts)}
          color="#f472b6" /* pink-400 */
          fillColor="rgba(244, 114, 182, 0.15)"
        />
      </div>
    </div>
  );
}

// ── SVG Sparkline ──────────────────────────────────────────────────────────

interface SparklineProps {
  label: string;
  data: number[];
  timestamps: number[];
  color: string;
  fillColor: string;
}

function Sparkline({ label, data, timestamps, color, fillColor }: SparklineProps) {
  const W = 300;
  const H = 80;
  const PAD = 1;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const current = data[data.length - 1];

  // Build SVG path
  const points = data.map((v, i) => {
    const x = PAD + ((W - 2 * PAD) * i) / (data.length - 1);
    const y = H - PAD - ((H - 2 * PAD) * (v - min)) / range;
    return { x, y };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');

  // Fill area (close path down to bottom)
  const fillPath = `${linePath} L${points[points.length - 1].x},${H} L${points[0].x},${H} Z`;

  // Time range label
  const startTime = new Date(timestamps[0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const endTime = new Date(timestamps[timestamps.length - 1]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="bg-zinc-900/50 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-zinc-400">{label}</span>
        <span className="text-sm font-bold tabular-nums" style={{ color }}>
          {Number.isInteger(current) ? current : current.toFixed(1)}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: 80 }}
        preserveAspectRatio="none"
      >
        {/* Grid lines */}
        {[0.25, 0.5, 0.75].map(frac => (
          <line
            key={frac}
            x1={0}
            y1={H - PAD - (H - 2 * PAD) * frac}
            x2={W}
            y2={H - PAD - (H - 2 * PAD) * frac}
            stroke="rgba(161, 161, 170, 0.1)"
            strokeWidth={0.5}
          />
        ))}

        {/* Fill */}
        <path d={fillPath} fill={fillColor} />

        {/* Line */}
        <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />

        {/* Current value dot */}
        <circle
          cx={points[points.length - 1].x}
          cy={points[points.length - 1].y}
          r={2.5}
          fill={color}
        />
      </svg>

      <div className="flex justify-between text-[10px] text-zinc-600 mt-1">
        <span>{startTime}</span>
        <span className="text-zinc-500">min: {Number.isInteger(min) ? min : min.toFixed(1)} / max: {Number.isInteger(max) ? max : max.toFixed(1)}</span>
        <span>{endTime}</span>
      </div>
    </div>
  );
}
