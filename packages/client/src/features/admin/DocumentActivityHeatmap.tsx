import React from 'react';
import type { RoomInfo } from './api';

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

interface Props {
  rooms: RoomInfo[];
}

/**
 * Document Activity Heatmap — shows most-edited documents sorted by edit rate.
 * Displays roomId, edit rate (updatesApplied), active editors, last activity.
 */
export function DocumentActivityHeatmap({ rooms }: Props) {
  // Sort by updatesApplied desc (edit rate proxy)
  const sorted = [...rooms].sort((a, b) => b.updatesApplied - a.updatesApplied);
  const maxUpdates = Math.max(1, sorted[0]?.updatesApplied ?? 1);

  return (
    <div className="bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-700 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Document Activity Heatmap</h3>
        <span className="text-xs text-zinc-500">{sorted.length} documents</span>
      </div>

      {sorted.length === 0 ? (
        <div className="p-8 text-center text-sm text-zinc-500">No active documents</div>
      ) : (
        <div className="divide-y divide-zinc-700/50">
          {sorted.map((room) => {
            const intensity = room.updatesApplied / maxUpdates;
            // Heat color: low → dim teal, high → bright orange/red
            const hue = Math.round(30 - intensity * 30); // 30 (orange) → 0 (red)
            const saturation = 60 + intensity * 40;
            const lightness = 25 + intensity * 25;

            return (
              <div
                key={room.roomId}
                className="px-4 py-3 flex items-center gap-3 hover:bg-zinc-700/30 transition-colors"
              >
                {/* Heat indicator */}
                <div
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{
                    backgroundColor: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
                    boxShadow: intensity > 0.5
                      ? `0 0 ${Math.round(intensity * 12)}px hsl(${hue}, ${saturation}%, ${lightness}%)`
                      : 'none',
                  }}
                />

                {/* Room ID */}
                <span
                  className="text-sm font-mono text-zinc-300 w-40 truncate flex-shrink-0"
                  title={room.roomId}
                >
                  {room.roomId}
                </span>

                {/* Edit rate bar */}
                <div className="flex-1 flex items-center gap-2">
                  <div className="flex-1 h-6 bg-zinc-900 rounded overflow-hidden relative">
                    <div
                      className="h-full rounded transition-all duration-700 ease-out"
                      style={{
                        width: `${Math.max(2, intensity * 100)}%`,
                        backgroundColor: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
                      }}
                    />
                    <span className="absolute inset-0 flex items-center px-2 text-xs font-mono text-zinc-200">
                      {room.updatesApplied.toLocaleString()} edits
                    </span>
                  </div>
                </div>

                {/* Editors badge */}
                <span className="flex-shrink-0 inline-flex items-center gap-1 text-xs">
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  <span className="text-zinc-300 tabular-nums">{room.editors}</span>
                  <span className="text-zinc-500">editors</span>
                </span>

                {/* Last activity */}
                <span className="flex-shrink-0 text-xs text-zinc-500 w-16 text-right tabular-nums">
                  {room.lastActivityTimestamp ? timeAgo(room.lastActivityTimestamp) : '—'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
