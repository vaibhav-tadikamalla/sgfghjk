import React from 'react';
import type { RoomInfo } from './api';

interface Props {
  rooms: RoomInfo[];
}

/**
 * Editor Heatmap — horizontal bar chart of editors per document.
 * Visualizes which documents have the most concurrent editors.
 */
export function EditorHeatmap({ rooms }: Props) {
  const sorted = [...rooms]
    .filter(r => r.editors > 0)
    .sort((a, b) => b.editors - a.editors)
    .slice(0, 20);

  const maxEditors = Math.max(1, sorted[0]?.editors ?? 1);

  return (
    <div className="bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-700 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Editor Heatmap</h3>
        <span className="text-xs text-zinc-500">
          {sorted.length} active document{sorted.length !== 1 ? 's' : ''}
        </span>
      </div>

      {sorted.length === 0 ? (
        <div className="p-8 text-center text-sm text-zinc-500">No active editors</div>
      ) : (
        <div className="p-4 space-y-2">
          {sorted.map((room) => {
            const pct = (room.editors / maxEditors) * 100;
            // Intensity-based color: fewer editors → cool blue, many → hot green
            const intensity = room.editors / maxEditors;

            return (
              <div key={room.roomId} className="flex items-center gap-3">
                {/* Room label */}
                <span
                  className="text-xs font-mono text-zinc-400 w-32 truncate flex-shrink-0 text-right"
                  title={room.roomId}
                >
                  {room.roomId}
                </span>

                {/* Bar */}
                <div className="flex-1 h-7 bg-zinc-900 rounded overflow-hidden relative">
                  <div
                    className="h-full rounded transition-all duration-500 ease-out flex items-center"
                    style={{
                      width: `${Math.max(3, pct)}%`,
                      backgroundColor: intensity > 0.7
                        ? `hsl(142, 70%, ${35 + intensity * 15}%)`  // bright green
                        : intensity > 0.4
                          ? `hsl(170, 60%, ${30 + intensity * 15}%)` // teal
                          : `hsl(210, 50%, ${30 + intensity * 10}%)`, // blue
                    }}
                  >
                    {/* Block segments to represent individual editors */}
                    <div className="flex items-center h-full gap-px px-1">
                      {Array.from({ length: Math.min(room.editors, 30) }).map((_, i) => (
                        <div
                          key={i}
                          className="h-4 w-2 rounded-sm opacity-60"
                          style={{
                            backgroundColor: intensity > 0.7
                              ? 'rgba(74, 222, 128, 0.5)'
                              : intensity > 0.4
                                ? 'rgba(94, 234, 212, 0.4)'
                                : 'rgba(147, 197, 253, 0.4)',
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-mono text-zinc-300 tabular-nums">
                    {room.editors}
                  </span>
                </div>
              </div>
            );
          })}

          {/* Legend */}
          <div className="flex items-center justify-end gap-4 pt-2 text-[10px] text-zinc-500">
            <span className="flex items-center gap-1">
              <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: 'hsl(210, 50%, 35%)' }} /> Low
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: 'hsl(170, 60%, 38%)' }} /> Medium
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: 'hsl(142, 70%, 45%)' }} /> High
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
