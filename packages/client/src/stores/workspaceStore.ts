import { create } from 'zustand';
import { api } from '@/lib/api';

// ─── Types  ───────────────────────────────────────────────────────────
export interface Folder {
  id: string;
  name: string;
  ownerId: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceFile {
  id: string;
  name: string;
  folderId: string;
  lastEditedBy: string | null;
  lastEditedAt: string | null;
  editorName: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface FolderPermission {
  userId: string;
  role: string;
  displayName: string;
  email: string;
  grantedAt: string;
}

export interface ActivityEntry {
  id: string;
  userId: string | null;
  displayName: string | null;
  actionType: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Contributor {
  userId: string;
  displayName: string;
  email: string;
  totalEdits: number;
  lastEditedAt: string;
}

// ─── Store ────────────────────────────────────────────────────────────
interface WorkspaceState {
  // Data
  folders: Folder[];
  files: WorkspaceFile[];
  trashFiles: WorkspaceFile[];
  activeFolder: Folder | null;
  activeFile: WorkspaceFile | null;
  activity: ActivityEntry[];
  contributors: Contributor[];

  // UI
  sidebarOpen: boolean;
  activityOpen: boolean;
  trashOpen: boolean;
  permissionsOpen: boolean;
  isLoading: boolean;

  // Actions
  setSidebarOpen: (open: boolean) => void;
  setActivityOpen: (open: boolean) => void;
  setTrashOpen: (open: boolean) => void;
  setPermissionsOpen: (open: boolean) => void;

  loadFolders: () => Promise<void>;
  createFolder: (name: string) => Promise<void>;
  renameFolder: (folderId: string, name: string) => Promise<void>;
  deleteFolder: (folderId: string) => Promise<void>;
  selectFolder: (folder: Folder) => Promise<void>;

  loadFiles: (folderId: string) => Promise<void>;
  createFile: (name: string, folderId: string) => Promise<void>;
  renameFile: (fileId: string, name: string) => Promise<void>;
  deleteFile: (fileId: string) => Promise<void>;
  selectFile: (file: WorkspaceFile | null) => void;

  loadTrash: (folderId: string) => Promise<void>;
  restoreFile: (fileId: string) => Promise<void>;
  permanentDeleteFile: (fileId: string) => Promise<void>;

  loadActivity: (folderId: string) => Promise<void>;
  loadFileActivity: (fileId: string) => Promise<void>;
  loadContributors: (fileId: string) => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  folders: [],
  files: [],
  trashFiles: [],
  activeFolder: null,
  activeFile: null,
  activity: [],
  contributors: [],

  sidebarOpen: true,
  activityOpen: false,
  trashOpen: false,
  permissionsOpen: false,
  isLoading: false,

  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setActivityOpen: (open) => set({ activityOpen: open }),
  setTrashOpen: (open) => set({ trashOpen: open }),
  setPermissionsOpen: (open) => set({ permissionsOpen: open }),

  loadFolders: async () => {
    set({ isLoading: true });
    try {
      const data = await api.get('api/folders').json<Folder[]>();
      set({ folders: data });
    } catch {
      // ignore
    } finally {
      set({ isLoading: false });
    }
  },

  createFolder: async (name) => {
    const data = await api.post('api/folders', { json: { name } }).json<Folder>();
    set((s) => ({ folders: [{ ...data, role: 'owner' }, ...s.folders] }));
  },

  renameFolder: async (folderId, name) => {
    await api.patch(`api/folders/${folderId}`, { json: { name } }).json();
    set((s) => ({
      folders: s.folders.map((f) => (f.id === folderId ? { ...f, name } : f)),
      activeFolder: s.activeFolder?.id === folderId ? { ...s.activeFolder, name } : s.activeFolder,
    }));
  },

  deleteFolder: async (folderId) => {
    await api.delete(`api/folders/${folderId}`);
    set((s) => ({
      folders: s.folders.filter((f) => f.id !== folderId),
      activeFolder: s.activeFolder?.id === folderId ? null : s.activeFolder,
      activeFile: s.activeFolder?.id === folderId ? null : s.activeFile,
      files: s.activeFolder?.id === folderId ? [] : s.files,
    }));
  },

  selectFolder: async (folder) => {
    set({ activeFolder: folder, activeFile: null, files: [] });
    await get().loadFiles(folder.id);
  },

  loadFiles: async (folderId) => {
    try {
      const data = await api.get(`api/folders/${folderId}/files`).json<WorkspaceFile[]>();
      set({ files: data });
    } catch {
      // ignore
    }
  },

  createFile: async (name, folderId) => {
    const data = await api.post('api/files', { json: { name, folderId } }).json<WorkspaceFile>();
    set((s) => ({ files: [{ ...data, editorName: null }, ...s.files] }));
  },

  renameFile: async (fileId, name) => {
    await api.patch(`api/files/${fileId}`, { json: { name } }).json();
    set((s) => ({
      files: s.files.map((f) => (f.id === fileId ? { ...f, name } : f)),
      activeFile: s.activeFile?.id === fileId ? { ...s.activeFile, name } : s.activeFile,
    }));
  },

  deleteFile: async (fileId) => {
    await api.delete(`api/files/${fileId}`);
    set((s) => ({
      files: s.files.filter((f) => f.id !== fileId),
      activeFile: s.activeFile?.id === fileId ? null : s.activeFile,
    }));
  },

  selectFile: (file) => set({ activeFile: file }),

  loadTrash: async (folderId) => {
    try {
      const data = await api.get(`api/folders/${folderId}/trash`).json<WorkspaceFile[]>();
      set({ trashFiles: data });
    } catch {
      // ignore
    }
  },

  restoreFile: async (fileId) => {
    await api.post(`api/files/${fileId}/restore`);
    set((s) => ({
      trashFiles: s.trashFiles.filter((f) => f.id !== fileId),
    }));
    const folder = get().activeFolder;
    if (folder) await get().loadFiles(folder.id);
  },

  permanentDeleteFile: async (fileId) => {
    await api.delete(`api/files/${fileId}/permanent`);
    set((s) => ({
      trashFiles: s.trashFiles.filter((f) => f.id !== fileId),
    }));
  },

  loadActivity: async (folderId) => {
    try {
      const data = await api.get(`api/folders/${folderId}/activity`).json<ActivityEntry[]>();
      set({ activity: data });
    } catch {
      // ignore
    }
  },

  loadFileActivity: async (fileId) => {
    try {
      const data = await api.get(`api/files/${fileId}/activity`).json<ActivityEntry[]>();
      set({ activity: data });
    } catch {
      // ignore
    }
  },

  loadContributors: async (fileId) => {
    try {
      const data = await api.get(`api/files/${fileId}/contributors`).json<Contributor[]>();
      set({ contributors: data });
    } catch {
      // ignore
    }
  },
}));
