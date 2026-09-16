import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useWorkspaceStore, type Folder, type WorkspaceFile } from '@/stores/workspaceStore';
import { useAuth } from '@/lib/auth/AuthContext';
import { cn } from '@/lib/utils/cn';

export function Sidebar() {
  const {
    folders, files, activeFolder, activeFile,
    loadFolders, selectFolder, selectFile,
    createFolder, createFile,
    renameFolder, deleteFolder,
    renameFile, deleteFile,
    setActivityOpen, setTrashOpen, setPermissionsOpen,
    setSidebarOpen,
  } = useWorkspaceStore();
  const { user, logout, deleteAccount } = useAuth();

  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [showNewFile, setShowNewFile] = useState(false);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showNewFolder || showNewFile || editingFolderId || editingFileId) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [showNewFolder, showNewFile, editingFolderId, editingFileId]);

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    await createFolder(name);
    setNewFolderName('');
    setShowNewFolder(false);
  };

  const handleCreateFile = async () => {
    const name = newFileName.trim();
    if (!name || !activeFolder) return;
    await createFile(name, activeFolder.id);
    setNewFileName('');
    setShowNewFile(false);
  };

  const startRenameFolder = (folder: Folder) => {
    setEditingFolderId(folder.id);
    setEditName(folder.name);
  };

  const commitRenameFolder = async () => {
    if (editingFolderId && editName.trim()) {
      await renameFolder(editingFolderId, editName.trim());
    }
    setEditingFolderId(null);
  };

  const startRenameFile = (file: WorkspaceFile) => {
    setEditingFileId(file.id);
    setEditName(file.name);
  };

  const commitRenameFile = async () => {
    if (editingFileId && editName.trim()) {
      await renameFile(editingFileId, editName.trim());
    }
    setEditingFileId(null);
  };

  return (
    <>
      {/* Header */}
      <div className="p-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="2" width="5" height="5" rx="1" fill="white"/>
              <rect x="9" y="2" width="5" height="5" rx="1" fill="white" opacity="0.6"/>
              <rect x="2" y="9" width="5" height="5" rx="1" fill="white" opacity="0.6"/>
              <rect x="9" y="9" width="5" height="5" rx="1" fill="white" opacity="0.3"/>
            </svg>
          </div>
          <span className="text-sm font-semibold text-text-primary">PeerGrid</span>
        </div>
        <button onClick={() => setSidebarOpen(false)} className="tool-btn" title="Close sidebar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="11,17 6,12 11,7" />
            <line x1="18" y1="12" x2="6" y2="12" />
          </svg>
        </button>
      </div>

      {/* Folders */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-2">
          <div className="flex items-center justify-between px-2 mb-1">
            <span className="label">Folders</span>
            <button
              onClick={() => setShowNewFolder(!showNewFolder)}
              className="tool-btn w-6 h-6"
              title="New folder"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>

          {showNewFolder && (
            <div className="px-1 mb-1">
              <input
                ref={inputRef}
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreateFolder();
                  if (e.key === 'Escape') setShowNewFolder(false);
                }}
                onBlur={() => void handleCreateFolder()}
                placeholder="Folder name…"
                className="w-full h-7 px-2 text-xs rounded bg-surface-2 border border-accent text-text-primary placeholder:text-text-muted focus:outline-none"
              />
            </div>
          )}

          {folders.map((folder) => (
            <div key={folder.id} className="group">
              {editingFolderId === folder.id ? (
                <input
                  ref={inputRef}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRenameFolder();
                    if (e.key === 'Escape') setEditingFolderId(null);
                  }}
                  onBlur={() => void commitRenameFolder()}
                  className="w-full h-7 px-2 text-xs rounded bg-surface-2 border border-accent text-text-primary focus:outline-none mx-1"
                />
              ) : (
                <button
                  onClick={() => void selectFolder(folder)}
                  onDoubleClick={() => startRenameFolder(folder)}
                  className={cn(
                    'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors',
                    activeFolder?.id === folder.id
                      ? 'bg-accent/15 text-accent'
                      : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary',
                  )}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  <span className="truncate flex-1 text-left">{folder.name}</span>
                  <span className="text-[10px] text-text-muted opacity-0 group-hover:opacity-100">{folder.role}</span>
                </button>
              )}
              {activeFolder?.id === folder.id && folder.role === 'owner' && (
                <div className="flex gap-0.5 pl-6 -mt-0.5 mb-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => startRenameFolder(folder)} className="tool-btn w-5 h-5" title="Rename">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    </svg>
                  </button>
                  <button onClick={() => void deleteFolder(folder.id)} className="tool-btn w-5 h-5 hover:text-red-400" title="Delete">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Files in active folder */}
        {activeFolder && (
          <div className="p-2 border-t border-border">
            <div className="flex items-center justify-between px-2 mb-1">
              <span className="label">Files</span>
              {(activeFolder.role === 'owner' || activeFolder.role === 'editor') && (
                <button
                  onClick={() => setShowNewFile(!showNewFile)}
                  className="tool-btn w-6 h-6"
                  title="New file"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              )}
            </div>

            {showNewFile && (
              <div className="px-1 mb-1">
                <input
                  ref={inputRef}
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreateFile();
                    if (e.key === 'Escape') setShowNewFile(false);
                  }}
                  onBlur={() => void handleCreateFile()}
                  placeholder="File name…"
                  className="w-full h-7 px-2 text-xs rounded bg-surface-2 border border-accent text-text-primary placeholder:text-text-muted focus:outline-none"
                />
              </div>
            )}

            {files.length === 0 && !showNewFile && (
              <p className="px-2 py-3 text-xs text-text-muted text-center">No files yet</p>
            )}

            {files.map((file) => (
              <div key={file.id} className="group">
                {editingFileId === file.id ? (
                  <input
                    ref={inputRef}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRenameFile();
                      if (e.key === 'Escape') setEditingFileId(null);
                    }}
                    onBlur={() => void commitRenameFile()}
                    className="w-full h-7 px-2 text-xs rounded bg-surface-2 border border-accent text-text-primary focus:outline-none mx-1"
                  />
                ) : (
                  <button
                    onClick={() => selectFile(file)}
                    onDoubleClick={() => startRenameFile(file)}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors',
                      activeFile?.id === file.id
                        ? 'bg-accent/15 text-accent'
                        : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary',
                    )}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                      <polyline points="14,2 14,8 20,8" />
                    </svg>
                    <span className="truncate flex-1 text-left">{file.name}</span>
                  </button>
                )}
                {(activeFolder.role === 'owner' || activeFolder.role === 'editor') && (
                  <div className="flex gap-0.5 pl-6 -mt-0.5 mb-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => startRenameFile(file)} className="tool-btn w-5 h-5" title="Rename">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      </svg>
                    </button>
                    <button onClick={() => void deleteFile(file.id)} className="tool-btn w-5 h-5 hover:text-red-400" title="Trash">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottom toolbar */}
      <div className="border-t border-border p-2 space-y-1">
        {activeFolder && (
          <div className="flex gap-1">
            <button
              onClick={() => {
                useWorkspaceStore.getState().setActivityOpen(!useWorkspaceStore.getState().activityOpen);
              }}
              className="tool-btn flex-1 text-[11px] gap-1"
              title="Activity"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
              Activity
            </button>
            <button
              onClick={() => {
                useWorkspaceStore.getState().setTrashOpen(true);
              }}
              className="tool-btn flex-1 text-[11px] gap-1"
              title="Trash"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              Trash
            </button>
            {activeFolder.role === 'owner' && (
              <button
                onClick={() => useWorkspaceStore.getState().setPermissionsOpen(true)}
                className="tool-btn flex-1 text-[11px] gap-1"
                title="Share"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <line x1="19" y1="8" x2="19" y2="14" />
                  <line x1="22" y1="11" x2="16" y2="11" />
                </svg>
                Share
              </button>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 px-2 py-1.5">
          <div className="w-6 h-6 rounded-full bg-accent flex items-center justify-center text-[10px] font-medium text-white">
            {user?.displayName?.charAt(0).toUpperCase() ?? '?'}
          </div>
          <span className="text-xs text-text-secondary truncate flex-1">{user?.displayName}</span>
          <button
            onClick={() => { setShowDeleteAccount(true); setDeletePassword(''); setDeleteError(''); }}
            className="tool-btn w-6 h-6"
            title="Delete account"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </button>
          <button onClick={() => void logout()} className="tool-btn w-6 h-6" title="Sign out">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Delete Account Modal */}
      {showDeleteAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-surface-1 border border-border rounded-lg shadow-xl w-full max-w-sm mx-4 p-5">
            <h3 className="text-base font-semibold text-red-400 mb-1">Delete Account</h3>
            <p className="text-xs text-text-secondary mb-4">
              This will permanently delete your account, all your folders, files, and data.
              This action cannot be undone. Enter your password to confirm.
            </p>
            <input
              type="password"
              placeholder="Enter your password"
              value={deletePassword}
              onChange={(e) => { setDeletePassword(e.target.value); setDeleteError(''); }}
              className="w-full px-3 py-2 text-sm rounded-md bg-surface-0 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-red-500 mb-2"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && deletePassword && !isDeleting) {
                  void handleDeleteAccount();
                }
              }}
            />
            {deleteError && (
              <p className="text-xs text-red-400 mb-2">{deleteError}</p>
            )}
            <div className="flex gap-2 justify-end mt-3">
              <button
                onClick={() => setShowDeleteAccount(false)}
                className="px-3 py-1.5 text-xs rounded-md bg-surface-0 border border-border text-text-secondary hover:bg-surface-2 transition-colors"
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                onClick={() => void handleDeleteAccount()}
                disabled={!deletePassword || isDeleting}
                className="px-3 py-1.5 text-xs rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isDeleting ? 'Deleting…' : 'Delete My Account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  async function handleDeleteAccount() {
    if (!deletePassword || isDeleting) return;
    setIsDeleting(true);
    setDeleteError('');
    try {
      await deleteAccount(deletePassword);
      // After deletion, the user state will clear and the router will redirect to login
    } catch (err: any) {
      setDeleteError(err.message || 'Failed to delete account');
    } finally {
      setIsDeleting(false);
    }
  }
}
