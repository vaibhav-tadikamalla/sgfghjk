import React, { useEffect } from 'react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { formatDistanceToNow } from 'date-fns';

export function TrashDrawer() {
  const {
    trashFiles, activeFolder, trashOpen,
    setTrashOpen, loadTrash, restoreFile, permanentDeleteFile,
  } = useWorkspaceStore();

  useEffect(() => {
    if (trashOpen && activeFolder) {
      void loadTrash(activeFolder.id);
    }
  }, [trashOpen, activeFolder?.id, loadTrash]);

  if (!trashOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setTrashOpen(false)} />

      {/* Dialog */}
      <div className="relative bg-surface-1 rounded-xl border border-border shadow-xl w-full max-w-md mx-4 max-h-[70vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Trash</h3>
            <p className="text-[11px] text-text-muted mt-0.5">
              {activeFolder?.name} — {trashFiles.length} item{trashFiles.length !== 1 ? 's' : ''}
            </p>
          </div>
          <button onClick={() => setTrashOpen(false)} className="tool-btn w-7 h-7">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {trashFiles.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-12">Trash is empty</p>
          ) : (
            <div className="divide-y divide-border">
              {trashFiles.map((file) => (
                <div key={file.id} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 transition-colors">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-muted shrink-0">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                    <polyline points="14,2 14,8 20,8" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-text-primary truncate">{file.name}</p>
                    {file.deletedAt && (
                      <p className="text-[10px] text-text-muted">
                        Deleted {formatDistanceToNow(new Date(file.deletedAt), { addSuffix: true })}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => void restoreFile(file.id)}
                      className="tool-btn w-7 h-7 text-green-400 hover:bg-green-500/10"
                      title="Restore"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="1 4 1 10 7 10" />
                        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                      </svg>
                    </button>
                    <button
                      onClick={() => {
                        if (confirm('Permanently delete this file? This cannot be undone.')) {
                          void permanentDeleteFile(file.id);
                        }
                      }}
                      className="tool-btn w-7 h-7 text-red-400 hover:bg-red-500/10"
                      title="Delete permanently"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
