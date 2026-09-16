import { fileService } from '../services/fileService';
import { editTrackingService } from '../services/editTrackingService';
import { activityService } from '../services/activityService';

// ─────────────────────────────────────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All database operations that the WebSocket collaboration layer needs.
 *
 * Extracting these behind an interface keeps the Room class and
 * CollaborationServer free of direct service imports, making the persistence
 * layer independently testable and mockable.
 */
export interface RoomPersistenceService {
  // ── Document state ────────────────────────────────────────────────────────

  /**
   * Load the persisted Yjs document snapshot for a file.
   * Returns null if no snapshot exists yet (new file or first open).
   */
  loadYdocState(fileId: string): Promise<Buffer | null>;

  /**
   * Persist the current Yjs document snapshot for a file.
   * Called on the periodic save timer and during graceful shutdown.
   */
  saveYdocState(fileId: string, state: Buffer): Promise<void>;

  /**
   * Update the `last_edited_by` / `last_edited_at` columns for a file.
   */
  updateLastEdited(fileId: string, userId: string): Promise<void>;

  // ── Edit tracking ─────────────────────────────────────────────────────────

  /**
   * Increment the edit counter for a specific user on a file.
   * Called on the periodic flush of in-memory edit counters.
   */
  incrementEditsBy(fileId: string, userId: string, count: number): Promise<void>;

  // ── Session tracking ──────────────────────────────────────────────────────

  /**
   * Record the start of an editing session for a user on a file.
   * Returns the session's unique ID (used when ending the session).
   */
  startSession(fileId: string, userId: string): Promise<string>;

  /**
   * Record the end of an editing session for a user on a file.
   */
  endSession(fileId: string, userId: string): Promise<void>;

  // ── Activity log ──────────────────────────────────────────────────────────

  /**
   * Append an activity-log entry.
   * Errors are non-fatal; the caller should not propagate them to the client.
   */
  logActivity(
    userId: string,
    actionType: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default implementation (delegates to existing service singletons)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Concrete implementation that delegates each call to the appropriate
 * existing service module (fileService, editTrackingService, activityService).
 *
 * All methods are thin pass-throughs; the actual SQL lives in those services.
 */
export class DefaultRoomPersistenceService implements RoomPersistenceService {
  async loadYdocState(fileId: string): Promise<Buffer | null> {
    return fileService.loadYdocState(fileId);
  }

  async saveYdocState(fileId: string, state: Buffer): Promise<void> {
    return fileService.saveYdocState(fileId, state);
  }

  async updateLastEdited(fileId: string, userId: string): Promise<void> {
    return fileService.updateLastEdited(fileId, userId);
  }

  async incrementEditsBy(fileId: string, userId: string, count: number): Promise<void> {
    return editTrackingService.incrementEditsBy(fileId, userId, count);
  }

  async startSession(fileId: string, userId: string): Promise<string> {
    return editTrackingService.startSession(fileId, userId);
  }

  async endSession(fileId: string, userId: string): Promise<void> {
    return editTrackingService.endSession(fileId, userId);
  }

  async logActivity(
    userId: string,
    actionType: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return activityService.log(userId, actionType, 'file', entityId, metadata);
  }
}
