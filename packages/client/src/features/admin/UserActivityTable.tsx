import React from 'react';
import type { AnalyticsInfo, UserInfo } from './api';

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function timeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

interface Props {
  users: UserInfo[];
  analytics?: AnalyticsInfo;
}

export function UserActivityTable({ users, analytics }: Props) {
  const now = Date.now();

  const topTypingSpeedByUser = new Map<string, number>();
  const pasteCountByUser = new Map<string, number>();

  if (analytics) {
    for (const row of analytics.avgEditsPerMinuteByUserFile) {
      const current = topTypingSpeedByUser.get(row.userId) ?? 0;
      if (row.avgEditsPerMinute > current) {
        topTypingSpeedByUser.set(row.userId, row.avgEditsPerMinute);
      }
    }

    for (const row of analytics.pasteEventsPerSession) {
      pasteCountByUser.set(row.userId, (pasteCountByUser.get(row.userId) ?? 0) + row.pasteEventsCount);
    }
  }

  return (
    <div className="bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-700 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">User Activity</h3>
        <span className="text-xs text-zinc-400">{users.length} users</span>
      </div>
      {users.length === 0 ? (
        <div className="p-6 text-center text-zinc-500 text-sm">No active users</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-400 border-b border-zinc-700/50">
                <th className="px-4 py-2 font-medium">User</th>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Role</th>
                <th className="px-4 py-2 font-medium text-right">Connections</th>
                <th className="px-4 py-2 font-medium">Current File</th>
                <th className="px-4 py-2 font-medium text-right">Top Typing Speed</th>
                <th className="px-4 py-2 font-medium text-right">Pastes Detected</th>
                <th className="px-4 py-2 font-medium text-right">Session</th>
                <th className="px-4 py-2 font-medium">Last Active</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => {
                const topTypingSpeed = topTypingSpeedByUser.get(u.userId) ?? null;
                const totalPastes = pasteCountByUser.get(u.userId) ?? 0;

                return (
                <tr key={u.userId} className="border-b border-zinc-700/30 hover:bg-zinc-700/30 transition-colors">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-[10px] font-bold text-white">
                        {(u.displayName || u.email || u.userId).charAt(0).toUpperCase()}
                      </div>
                      <span className="text-zinc-200 text-sm">{u.displayName || u.userId.slice(0, 8)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-zinc-400 text-xs">{u.email || '–'}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                      u.role === 'owner' ? 'bg-amber-500/20 text-amber-400' :
                      u.role === 'editor' ? 'bg-green-500/20 text-green-400' :
                      u.role === 'viewer' ? 'bg-purple-500/20 text-purple-400' :
                      'bg-zinc-500/20 text-zinc-400'
                    }`}>
                      {u.role || 'unknown'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right text-zinc-300">{u.activeConnections}</td>
                  <td className="px-4 py-2 font-mono text-xs text-zinc-400 max-w-[100px] truncate" title={u.currentFileId}>
                    {u.currentFileId ? u.currentFileId.slice(0, 8) + '…' : '–'}
                  </td>
                  <td className="px-4 py-2 text-right text-zinc-300 text-xs">
                    {topTypingSpeed === null ? '–' : `${topTypingSpeed.toFixed(1)} epm`}
                  </td>
                  <td className="px-4 py-2 text-right text-zinc-300 text-xs">{totalPastes}</td>
                  <td className="px-4 py-2 text-right text-zinc-300 text-xs">{formatDuration(u.sessionDurationMs)}</td>
                  <td className="px-4 py-2 text-zinc-400 text-xs">{timeAgo(now - u.lastActivityTimestamp)}</td>
                </tr>
              );})}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
