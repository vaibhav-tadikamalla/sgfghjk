import React from 'react';

interface CollabUser {
  id: string;
  displayName: string;
  color: string;
}

interface ActiveUsersProps {
  users: CollabUser[];
}

export function ActiveUsers({ users }: ActiveUsersProps) {
  if (users.length === 0) return null;

  const visible = users.slice(0, 5);
  const overflow = users.length - visible.length;

  return (
    <div className="flex items-center -space-x-1.5">
      {visible.map((u) => (
        <div
          key={u.id}
          title={u.displayName}
          className="w-6 h-6 rounded-full border-2 border-surface-1 flex items-center justify-center text-[10px] font-medium text-white"
          style={{ backgroundColor: u.color }}
        >
          {u.displayName.charAt(0).toUpperCase()}
        </div>
      ))}
      {overflow > 0 && (
        <div className="w-6 h-6 rounded-full border-2 border-surface-1 bg-surface-3 flex items-center justify-center text-[10px] text-text-muted font-medium">
          +{overflow}
        </div>
      )}
    </div>
  );
}
