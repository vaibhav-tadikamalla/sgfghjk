import React, { useEffect } from 'react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { formatDistanceToNow } from 'date-fns';

const actionLabels: Record<string, string> = {
  folder_created: 'Created folder',
  folder_renamed: 'Renamed folder',
  folder_deleted: 'Deleted folder',
  file_created: 'Created file',
  file_renamed: 'Renamed file',
  file_deleted: 'Moved to trash',
  file_restored: 'Restored file',
  file_permanent_deleted: 'Permanently deleted',
  permission_granted: 'Shared with user',
  permission_revoked: 'Removed access',
  edit_session_started: 'Started editing',
  edit_session_ended: 'Finished editing',
};

const actionIcons: Record<string, string> = {
  folder_created: '📁',
  folder_renamed: '✏️',
  folder_deleted: '🗑️',
  file_created: '📄',
  file_renamed: '✏️',
  file_deleted: '🗑️',
  file_restored: '♻️',
  file_permanent_deleted: '❌',
  permission_granted: '🔗',
  permission_revoked: '🔒',
  edit_session_started: '✍️',
  edit_session_ended: '✅',
};

export function ActivityDrawer() {
  const { activity, activeFolder, activeFile, loadActivity } = useWorkspaceStore();

  useEffect(() => {
    if (activeFolder) {
      void loadActivity(activeFolder.id);
    }
  }, [activeFolder?.id, loadActivity]);

  return (
    <div className="h-full flex flex-col bg-surface-1">
      <div className="p-3 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary">Activity</h3>
        <p className="text-[11px] text-text-muted mt-0.5">
          {activeFolder?.name ?? 'Select a folder'}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {activity.length === 0 ? (
          <p className="text-xs text-text-muted text-center py-8">No activity yet</p>
        ) : (
          <div className="divide-y divide-border">
            {activity.map((entry) => (
              <div key={entry.id} className="px-3 py-2.5 hover:bg-surface-2 transition-colors">
                <div className="flex items-start gap-2">
                  <span className="text-sm mt-0.5">
                    {actionIcons[entry.actionType] ?? '📋'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-text-primary">
                      <span className="font-medium">{entry.displayName ?? 'System'}</span>
                      {' '}
                      <span className="text-text-secondary">
                        {actionLabels[entry.actionType] ?? entry.actionType}
                      </span>
                    </p>
                    {typeof entry.metadata?.name === 'string' && (
                      <p className="text-[11px] text-text-muted truncate mt-0.5">
                        {entry.metadata.name}
                      </p>
                    )}
                    <p className="text-[10px] text-text-muted mt-0.5">
                      {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true })}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
