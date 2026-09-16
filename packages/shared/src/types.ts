// ─── Workspace Types ───

export type WorkspaceRole = 'owner' | 'editor' | 'viewer';

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
}

export interface Folder {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface FolderWithRole extends Folder {
  role: WorkspaceRole;
}

export interface WorkspaceFile {
  id: string;
  name: string;
  folderId: string;
  lastEditedBy: string | null;
  lastEditedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface FileWithEditor extends WorkspaceFile {
  editorName: string | null;
}

export interface FolderPermission {
  folderId: string;
  userId: string;
  role: WorkspaceRole;
  displayName: string;
  email: string;
  grantedAt: string;
}

export interface ActivityEntry {
  id: string;
  userId: string | null;
  displayName: string | null;
  actionType: string;
  entityType: 'folder' | 'file';
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

export interface SearchResult {
  id: string;
  name: string;
  folderId: string;
  folderName: string;
  lastEditedAt: string | null;
  updatedAt: string;
}
