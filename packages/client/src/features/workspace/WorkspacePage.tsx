import React, { useEffect } from 'react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { Sidebar } from './Sidebar';
import { FileEditor } from './FileEditor';
import { ActivityDrawer } from './ActivityDrawer';
import { TrashDrawer } from './TrashDrawer';
import { PermissionsModal } from './PermissionsModal';

export function WorkspacePage() {
  const { loadFolders, activeFile, sidebarOpen, activityOpen } =
    useWorkspaceStore();

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  return (
    <div className="h-screen w-screen flex bg-surface-0 overflow-hidden">
      {/* Sidebar */}
      {sidebarOpen && (
        <div className="w-64 flex-shrink-0 border-r border-border bg-surface-1 flex flex-col h-full">
          <Sidebar />
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 h-full">
        {activeFile ? (
          <FileEditor key={activeFile.id} />
        ) : (
          <EmptyState />
        )}
      </div>

      {/* Activity drawer */}
      {activityOpen && (
        <div className="w-72 flex-shrink-0 border-l border-border bg-surface-1 flex flex-col h-full">
          <ActivityDrawer />
        </div>
      )}

      {/* Trash drawer */}
      <TrashDrawer />

      {/* Permissions modal */}
      <PermissionsModal />
    </div>
  );
}

function EmptyState() {
  const { sidebarOpen, setSidebarOpen } = useWorkspaceStore();
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-surface-2 border border-border flex items-center justify-center mx-auto">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-muted">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
            <polyline points="14,2 14,8 20,8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
        </div>
        <div>
          <p className="text-text-secondary text-sm">Select a file to start editing</p>
          <p className="text-text-muted text-xs mt-1">or create a new one from the sidebar</p>
        </div>
        {!sidebarOpen && (
          <button
            onClick={() => setSidebarOpen(true)}
            className="btn-ghost text-accent text-xs"
          >
            Open sidebar
          </button>
        )}
      </div>
    </div>
  );
}
