import { permissionService } from '../services/workspacePermissionService';
import type { WorkspaceRole } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Permission checks needed by the WebSocket collaboration layer.
 *
 * Keeping these behind an interface decouples the WebSocket handler from the
 * concrete permission-service implementation and makes it possible to swap in a
 * test double without touching any other module.
 */
export interface PermissionGateway {
  /**
   * Return the role a user holds on a specific file (or null when the user has
   * no access at all).
   */
  getRoleForFile(
    userId: string,
    fileId: string,
  ): Promise<WorkspaceRole | null>;

  /**
   * Return true when the user may read (open) the file.
   */
  canReadFile(userId: string, fileId: string): Promise<boolean>;

  /**
   * Return true when the user may write (edit) the file.
   * Owners and editors pass; viewers do not.
   */
  canWriteFile(userId: string, fileId: string): Promise<boolean>;

  /**
   * Return the workspace (folder) ID that contains the file, or null if the
   * file does not exist or has been soft-deleted.
   */
  getFolderIdForFile(fileId: string): Promise<string | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Concrete implementation that delegates to the shared `permissionService`
 * singleton, which performs the actual SQL lookups.
 */
export class WorkspacePermissionGateway implements PermissionGateway {
  async getRoleForFile(
    userId: string,
    fileId: string,
  ): Promise<WorkspaceRole | null> {
    // Simulation bypass: sim-* rooms auto-grant editor to sim-user-* users
    if (fileId.startsWith('sim-') && userId.startsWith('sim-user-')) return 'editor';
    // permissionService expects (fileId, userId)
    return permissionService.getRoleForFile(fileId, userId);
  }

  async canReadFile(userId: string, fileId: string): Promise<boolean> {
    if (fileId.startsWith('sim-') && userId.startsWith('sim-user-')) return true;
    return permissionService.canReadFile(fileId, userId);
  }

  async canWriteFile(userId: string, fileId: string): Promise<boolean> {
    if (fileId.startsWith('sim-') && userId.startsWith('sim-user-')) return true;
    return permissionService.canWriteFile(fileId, userId);
  }

  async getFolderIdForFile(fileId: string): Promise<string | null> {
    if (fileId.startsWith('sim-')) return 'sim-workspace';
    return permissionService.getFolderIdForFile(fileId);
  }
}
