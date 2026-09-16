import React from 'react';
import type { AnalyticsInfo } from './api';

interface Props {
  analytics: AnalyticsInfo;
}

export function RealtimeCharts({ analytics }: Props) {
  const topRooms = analytics.roomRates.slice(0, 10);
  const maxUpdates = Math.max(1, ...topRooms.map(r => r.updatesApplied));
  const maxEditors = Math.max(1, ...topRooms.map(r => r.editors));
  const pasteSessions = analytics.pasteEventsPerSession.slice(0, 6);
  const editVelocity = analytics.avgEditsPerMinuteByUserFile.slice(0, 6);

  return (
    <div className="bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-700">
        <h3 className="text-sm font-semibold text-white">Realtime Metrics</h3>
      </div>
      <div className="p-4 space-y-6">
        {/* Global Rate Summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <RateCard label="Edits / min" value={analytics.editsPerMinute} />
          <RateCard label="Editors" value={analytics.activeEditors} />
          <RateCard label="Viewers" value={analytics.activeViewers} />
          <RateCard label="WS Conns" value={analytics.websocketConnections} />
        </div>

        {/* Updates Per Room */}
        {topRooms.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
              Updates Applied by Room (top {topRooms.length})
            </h4>
            <div className="space-y-1">
              {topRooms.map(room => {
                const pct = Math.round((room.updatesApplied / maxUpdates) * 100);
                return (
                  <div key={room.roomId} className="flex items-center gap-2">
                    <span className="text-xs font-mono text-zinc-400 w-28 truncate" title={room.roomId}>
                      {room.roomId.length > 12 ? room.roomId.slice(0, 12) + '…' : room.roomId}
                    </span>
                    <div className="flex-1 h-5 bg-zinc-700 rounded-sm overflow-hidden relative">
                      <div
                        className="h-full bg-indigo-500 rounded-sm transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                      <span className="absolute inset-0 flex items-center justify-end pr-1 text-[10px] text-zinc-300 font-mono">
                        {room.updatesApplied}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Editors Per Room */}
        {topRooms.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
              Editors by Room (top {topRooms.length})
            </h4>
            <div className="space-y-1">
              {topRooms.map(room => {
                const pct = Math.round((room.editors / maxEditors) * 100);
                return (
                  <div key={room.roomId} className="flex items-center gap-2">
                    <span className="text-xs font-mono text-zinc-400 w-28 truncate" title={room.roomId}>
                      {room.roomId.length > 12 ? room.roomId.slice(0, 12) + '…' : room.roomId}
                    </span>
                    <div className="flex-1 h-5 bg-zinc-700 rounded-sm overflow-hidden relative">
                      <div
                        className="h-full bg-emerald-500 rounded-sm transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                      <span className="absolute inset-0 flex items-center justify-end pr-1 text-[10px] text-zinc-300 font-mono">
                        {room.editors}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Connections Per Room */}
        {topRooms.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
              Connections by Room (top {topRooms.length})
            </h4>
            <div className="space-y-1">
              {topRooms.map(room => {
                const maxConns = Math.max(1, ...topRooms.map(r => r.connections));
                const pct = Math.round((room.connections / maxConns) * 100);
                return (
                  <div key={room.roomId} className="flex items-center gap-2">
                    <span className="text-xs font-mono text-zinc-400 w-28 truncate" title={room.roomId}>
                      {room.roomId.length > 12 ? room.roomId.slice(0, 12) + '…' : room.roomId}
                    </span>
                    <div className="flex-1 h-5 bg-zinc-700 rounded-sm overflow-hidden relative">
                      <div
                        className="h-full bg-cyan-500 rounded-sm transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                      <span className="absolute inset-0 flex items-center justify-end pr-1 text-[10px] text-zinc-300 font-mono">
                        {room.connections}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Reviewer Visibility */}
        <div>
          <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
            Reviewer Visibility
          </h4>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded border border-zinc-700 bg-zinc-900/40 overflow-hidden">
              <div className="px-3 py-2 border-b border-zinc-700 text-[11px] font-medium text-zinc-300 uppercase tracking-wide">
                Paste Events Per Session
              </div>
              {pasteSessions.length === 0 ? (
                <div className="px-3 py-4 text-xs text-zinc-500">No paste events captured yet.</div>
              ) : (
                <div className="divide-y divide-zinc-800">
                  {pasteSessions.map((session) => (
                    <div key={session.sessionId} className="px-3 py-2 text-xs flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-zinc-200 truncate" title={session.fileName}>{session.fileName}</div>
                        <div className="text-zinc-500 truncate" title={session.email}>{session.displayName}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono text-rose-300">{session.pasteEventsCount} paste{session.pasteEventsCount !== 1 ? 's' : ''}</div>
                        <div className="text-zinc-500 font-mono">{session.editsCount} edits</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded border border-zinc-700 bg-zinc-900/40 overflow-hidden">
              <div className="px-3 py-2 border-b border-zinc-700 text-[11px] font-medium text-zinc-300 uppercase tracking-wide">
                Avg Edits Per Minute (User x File)
              </div>
              {editVelocity.length === 0 ? (
                <div className="px-3 py-4 text-xs text-zinc-500">No edit velocity data yet.</div>
              ) : (
                <div className="divide-y divide-zinc-800">
                  {editVelocity.map((row) => (
                    <div key={`${row.fileId}:${row.userId}`} className="px-3 py-2 text-xs flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-zinc-200 truncate" title={row.fileName}>{row.fileName}</div>
                        <div className="text-zinc-500 truncate" title={row.email}>{row.displayName}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono text-emerald-300">{row.avgEditsPerMinute.toFixed(2)} edits/min</div>
                        <div className="text-zinc-500 font-mono">{row.sessions} session{row.sessions !== 1 ? 's' : ''}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {topRooms.length === 0 && (
          <div className="text-center text-sm text-zinc-500 py-8">No active rooms to chart</div>
        )}
      </div>
    </div>
  );
}

function RateCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-zinc-900/50 rounded p-3 text-center">
      <div className="text-lg font-bold text-white tabular-nums">{value}</div>
      <div className="text-xs text-zinc-500 mt-0.5">{label}</div>
    </div>
  );
}
