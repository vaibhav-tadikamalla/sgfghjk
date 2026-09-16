import React, { useEffect, useState } from 'react';
import { useWorkspaceStore, type FolderPermission } from '@/stores/workspaceStore';
import { api } from '@/lib/api';

export function PermissionsModal() {
  const { permissionsOpen, setPermissionsOpen, activeFolder } = useWorkspaceStore();
  const [permissions, setPermissions] = useState<FolderPermission[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchPermissions = async () => {
    if (!activeFolder) return;
    try {
      const data = await api.get(`api/folders/${activeFolder.id}/permissions`).json<FolderPermission[]>();
      setPermissions(data);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (permissionsOpen && activeFolder) {
      void fetchPermissions();
    }
  }, [permissionsOpen, activeFolder?.id]);

  const handleShare = async () => {
    if (!email.trim() || !activeFolder) return;
    setError('');
    setLoading(true);
    try {
      await api.post(`api/folders/${activeFolder.id}/permissions`, {
        json: { email: email.trim(), role },
      });
      setEmail('');
      await fetchPermissions();
    } catch (e: any) {
      const body = await e?.response?.json?.().catch(() => null);
      setError(body?.error ?? 'Failed to share');
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async (userId: string) => {
    if (!activeFolder) return;
    try {
      await api.delete(`api/folders/${activeFolder.id}/permissions/${userId}`);
      setPermissions((prev) => prev.filter((p) => p.userId !== userId));
    } catch {
      // ignore
    }
  };

  if (!permissionsOpen || !activeFolder) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setPermissionsOpen(false)} />

      <div className="relative bg-surface-1 rounded-xl border border-border shadow-xl w-full max-w-md mx-4 max-h-[70vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Share "{activeFolder.name}"</h3>
            <p className="text-[11px] text-text-muted mt-0.5">Manage who has access to this folder</p>
          </div>
          <button onClick={() => setPermissionsOpen(false)} className="tool-btn w-7 h-7">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Add user */}
        <div className="p-4 border-b border-border">
          <div className="flex gap-2">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleShare();
              }}
              placeholder="Email address…"
              className="flex-1 h-8 px-3 text-xs rounded-lg bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}
              className="h-8 px-2 text-xs rounded-lg bg-surface-2 border border-border text-text-primary focus:outline-none"
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button
              onClick={() => void handleShare()}
              disabled={loading || !email.trim()}
              className="h-8 px-3 text-xs rounded-lg bg-accent text-white font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Share
            </button>
          </div>
          {error && (
            <p className="text-[11px] text-red-400 mt-1.5">{error}</p>
          )}
        </div>

        {/* Permission list */}
        <div className="flex-1 overflow-y-auto">
          {permissions.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-8">No collaborators yet</p>
          ) : (
            <div className="divide-y divide-border">
              {permissions.map((perm) => (
                <div key={perm.userId} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-8 h-8 rounded-full bg-surface-3 flex items-center justify-center text-xs font-medium text-text-primary shrink-0">
                    {perm.displayName.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-text-primary truncate">{perm.displayName}</p>
                    <p className="text-[11px] text-text-muted truncate">{perm.email}</p>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                    perm.role === 'owner'
                      ? 'bg-accent/20 text-accent'
                      : perm.role === 'editor'
                        ? 'bg-blue-500/20 text-blue-400'
                        : 'bg-gray-500/20 text-gray-400'
                  }`}>
                    {perm.role}
                  </span>
                  {perm.role !== 'owner' && (
                    <button
                      onClick={() => void handleRevoke(perm.userId)}
                      className="tool-btn w-7 h-7 hover:text-red-400"
                      title="Remove access"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
