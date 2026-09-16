import React from 'react';
import type { RoomInfo } from './api';

function timeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  rooms: RoomInfo[];
  title?: string;
}

export function ActiveRoomsTable({ rooms, title = 'Active Rooms' }: Props) {
  const now = Date.now();

  return (
    <div className="bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-700 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <span className="text-xs text-zinc-400">{rooms.length} rooms</span>
      </div>
      {rooms.length === 0 ? (
        <div className="p-6 text-center text-zinc-500 text-sm">No rooms active</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-400 border-b border-zinc-700/50">
                <th className="px-4 py-2 font-medium">Room ID</th>
                <th className="px-4 py-2 font-medium">State</th>
                <th className="px-4 py-2 font-medium text-right">Editors</th>
                <th className="px-4 py-2 font-medium text-right">Viewers</th>
                <th className="px-4 py-2 font-medium text-right">Conns</th>
                <th className="px-4 py-2 font-medium text-center">Mirror</th>
                <th className="px-4 py-2 font-medium text-right">Applied</th>
                <th className="px-4 py-2 font-medium text-right">Broadcast</th>
                <th className="px-4 py-2 font-medium text-right">Size</th>
                <th className="px-4 py-2 font-medium">Last Activity</th>
                <th className="px-4 py-2 font-medium">Owner</th>
              </tr>
            </thead>
            <tbody>
              {rooms.map(r => {
                const idle = (now - r.lastActivityTimestamp) > 300_000;
                return (
                  <tr
                    key={r.roomId}
                    className={`border-b border-zinc-700/30 hover:bg-zinc-700/30 transition-colors ${idle ? 'opacity-50' : ''}`}
                  >
                    <td className="px-4 py-2 font-mono text-xs text-zinc-300 max-w-[120px] truncate" title={r.roomId}>
                      {r.roomId.slice(0, 8)}…
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        r.state === 'active' ? 'bg-green-500/20 text-green-400' :
                        r.state === 'idle' ? 'bg-yellow-500/20 text-yellow-400' :
                        r.state === 'loading' ? 'bg-blue-500/20 text-blue-400' :
                        'bg-zinc-500/20 text-zinc-400'
                      }`}>
                        {r.state}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right text-green-400 font-medium">{r.editors}</td>
                    <td className="px-4 py-2 text-right text-purple-400">{r.viewers}</td>
                    <td className="px-4 py-2 text-right text-zinc-300">{r.connections}</td>
                    <td className="px-4 py-2 text-center">
                      {r.mirrors ? (
                        <span className="text-cyan-400">●</span>
                      ) : (
                        <span className="text-zinc-600">–</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-zinc-300 font-mono text-xs">{r.updatesApplied.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right text-zinc-300 font-mono text-xs">{r.updatesBroadcast.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right text-zinc-400 text-xs">{formatBytes(r.estimatedSizeBytes)}</td>
                    <td className="px-4 py-2 text-zinc-400 text-xs">{timeAgo(now - r.lastActivityTimestamp)}</td>
                    <td className="px-4 py-2 font-mono text-xs text-zinc-500">
                      {r.ownerNode ? r.ownerNode.slice(0, 8) + '…' : 'local'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
