/**
 * versionService.ts
 *
 * Business logic for Document Version History.
 *
 * Responsibilities:
 *   1. Auto-capture — called after each snapshot save with coalescing logic
 *   2. Manual capture — named checkpoints from the REST API
 *   3. Diff — compute minimal Yjs diff between any two versions
 *   4. Restore — apply a historical version as a new Yjs update
 *   5. Retention — prune excess/old versions after each capture
 *
 * Design:
 *   - NEVER touches the CRDT core.  Reads compacted snapshot bytes.
 *   - Restore is implemented as a Y.Doc diff applied through the normal
 *     write path, preserving all collaboration guarantees.
 *   - All operations are non-blocking and failure-tolerant.
 */

import * as Y from 'yjs';
import { getLogger } from '../utils/logger';
import {
  saveVersion,
  listVersions,
  loadVersion,
  loadLatestVersion,
  pruneVersions,
  hashSnapshot,
  type DocumentVersion,
  type DocumentVersionMeta,
} from '../persistence/versionStore';
import { loadSnapshot } from '../persistence/snapshotStore';
import { appendUpdate } from '../persistence/updateLog';
import {
  versionCapturesTotal,
  versionCaptureBytes,
  versionRestoreTotal,
  versionPruneTotal,
  versionDiffDuration,
  versionAutoSkipTotal,
} from '../metrics/versionMetrics';

const logger = getLogger();

// ── Auto-capture thresholds ──────────────────────────────────────────────────

/** Minimum time between auto-captures for the same file (60 seconds). */
const MIN_CAPTURE_INTERVAL_MS = 60_000;

/** Minimum byte-size change to justify an auto-capture (1 KB). */
const MIN_DELTA_BYTES = 1024;

/** Maximum concurrent diff computations to prevent CPU starvation. */
const MAX_DIFF_TIMEOUT_MS = 5_000;
const ROOT_FRAGMENT_KEY = 'default';

// ── In-memory bookkeeping for auto-capture coalescing ────────────────────────

interface CaptureState {
  lastCapturedAt: number;
  lastHash: string;
  lastByteSize: number;
}

const captureStates = new Map<string, CaptureState>();

// ─────────────────────────────────────────────────────────────────────────────
// 1. Auto-capture
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hook called by the snapshot save cycle.  Evaluates whether the current
 * document state warrants a new version capture.
 *
 * Coalescing rules:
 *   - Skip if last capture was < MIN_CAPTURE_INTERVAL_MS ago
 *   - Skip if content hash is unchanged (identical state)
 *   - Skip if byte-size delta is below MIN_DELTA_BYTES
 *
 * @param fileId   The document identifier
 * @param snapshot V2-encoded snapshot bytes (as produced by saveSnapshot)
 */
export async function autoCapture(
  fileId: string,
  snapshot: Buffer,
): Promise<string | null> {
  const now = Date.now();
  const hash = hashSnapshot(snapshot);
  const state = captureStates.get(fileId);

  // ── Coalescing checks ───────────────────────────────────────────────────
  if (state) {
    // Too soon?
    if (now - state.lastCapturedAt < MIN_CAPTURE_INTERVAL_MS) {
      versionAutoSkipTotal.inc({ reason: 'too_soon' });
      return null;
    }

    // Identical content?
    if (state.lastHash === hash) {
      versionAutoSkipTotal.inc({ reason: 'duplicate' });
      return null;
    }

    // Insufficient change?
    const delta = Math.abs(snapshot.byteLength - state.lastByteSize);
    if (delta < MIN_DELTA_BYTES) {
      versionAutoSkipTotal.inc({ reason: 'too_small' });
      return null;
    }
  }

  // ── Capture ─────────────────────────────────────────────────────────────
  const versionId = await saveVersion({
    fileId,
    snapshot,
    source: 'auto',
  });

  if (versionId) {
    captureStates.set(fileId, {
      lastCapturedAt: now,
      lastHash: hash,
      lastByteSize: snapshot.byteLength,
    });
    versionCapturesTotal.inc({ source: 'auto' });
    versionCaptureBytes.observe(snapshot.byteLength);

    // ── Best-effort retention pruning ───────────────────────────────────
    void pruneVersions(fileId).then((pruned) => {
      if (pruned > 0) versionPruneTotal.inc(pruned);
    });
  }

  return versionId;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Manual capture (named checkpoint)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a named version checkpoint for a file.
 *
 * Loads the current document state (snapshot + WAL replay), captures it
 * as a version with the given label.
 *
 * @param fileId    The document identifier
 * @param label     User-provided version name
 * @param userId    The user creating the checkpoint
 */
export async function createCheckpoint(
  fileId: string,
  label: string,
  userId: string,
): Promise<DocumentVersionMeta | null> {
  const snapshot = await loadSnapshot(fileId);
  if (!snapshot) {
    logger.warn({ fileId }, '[versionService] cannot create checkpoint — no snapshot');
    return null;
  }

  // Re-encode as V2 for storage efficiency
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(snapshot));
  const v2Snapshot = Buffer.from(Y.encodeStateAsUpdateV2(doc));

  const versionId = await saveVersion({
    fileId,
    snapshot: v2Snapshot,
    source: 'manual',
    label,
    createdBy: userId,
  });

  if (!versionId) return null;

  versionCapturesTotal.inc({ source: 'manual' });
  versionCaptureBytes.observe(v2Snapshot.byteLength);

  // Re-read the meta to return a consistent projection
  const latest = await loadLatestVersion(fileId);
  return latest;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. List versions
// ─────────────────────────────────────────────────────────────────────────────

export { listVersions } from '../persistence/versionStore';

// ─────────────────────────────────────────────────────────────────────────────
// 4. Diff between two versions
// ─────────────────────────────────────────────────────────────────────────────

export interface VersionDiff {
  fromVersionId: string;
  toVersionId: string;
  /** V2-encoded minimal diff (apply to `from` to get `to`). */
  diff: Buffer;
  diffBytes: number;
}

/**
 * Compute a minimal Yjs diff between two versions of a document.
 *
 * Uses Y.diffUpdateV2: given the full state of version A and the state
 * vector of version B, it produces only the operations needed to
 * transform A → B.
 *
 * @param fileId        Document identifier
 * @param fromVersionId Base version
 * @param toVersionId   Target version (defaults to "current" if null)
 */
export async function diffVersions(
  fileId: string,
  fromVersionId: string,
  toVersionId: string | null,
): Promise<VersionDiff | null> {
  const t0 = performance.now();

  try {
    // ── Load "from" version ──────────────────────────────────────────────
    const fromVersion = await loadVersion(fileId, fromVersionId);
    if (!fromVersion) {
      logger.warn({ fileId, fromVersionId }, '[versionService] from-version not found');
      return null;
    }

    // ── Load "to" state ──────────────────────────────────────────────────
    let toSnapshot: Uint8Array;
    let resolvedToId: string;

    if (toVersionId) {
      const toVersion = await loadVersion(fileId, toVersionId);
      if (!toVersion) {
        logger.warn({ fileId, toVersionId }, '[versionService] to-version not found');
        return null;
      }
      toSnapshot = new Uint8Array(toVersion.snapshot);
      resolvedToId = toVersionId;
    } else {
      // "to" = current document state
      const current = await loadSnapshot(fileId);
      if (!current) {
        logger.warn({ fileId }, '[versionService] current snapshot not available');
        return null;
      }
      toSnapshot = new Uint8Array(current);
      resolvedToId = 'current';
    }

    // ── Decode from-version to extract its state vector ──────────────────
    const fromDoc = new Y.Doc();
    try {
      Y.applyUpdateV2(fromDoc, new Uint8Array(fromVersion.snapshot));
    } catch {
      Y.applyUpdate(fromDoc, new Uint8Array(fromVersion.snapshot));
    }
    const fromSV = Y.encodeStateVector(fromDoc);

    // ── Decode to-state into a doc so we can diff against from's SV ──────
    const toDoc = new Y.Doc();
    try {
      Y.applyUpdateV2(toDoc, toSnapshot);
    } catch {
      Y.applyUpdate(toDoc, toSnapshot);
    }

    // Diff: operations in toDoc that are NOT in fromDoc
    const diffV2 = Y.encodeStateAsUpdateV2(toDoc, fromSV);
    const diffBuf = Buffer.from(diffV2);

    const elapsed = performance.now() - t0;
    versionDiffDuration.observe(elapsed);

    if (elapsed > MAX_DIFF_TIMEOUT_MS) {
      logger.warn(
        { fileId, fromVersionId, toVersionId: resolvedToId, elapsed: `${elapsed.toFixed(0)}ms` },
        '[versionService] diff computation exceeded timeout threshold',
      );
    }

    return {
      fromVersionId,
      toVersionId: resolvedToId,
      diff: diffBuf,
      diffBytes: diffBuf.byteLength,
    };
  } catch (err) {
    logger.error({ err, fileId, fromVersionId, toVersionId }, '[versionService] diffVersions failed');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Restore a version
// ─────────────────────────────────────────────────────────────────────────────

export interface RestoreResult {
  success: boolean;
  versionId: string | null;       // the new version (of type 'restore') if created
  walSeq: bigint | null;          // the WAL sequence of the restore update
  bytesApplied: number;
  error?: string;
}

/**
 * Restore a document to a previous version.
 *
 * Strategy:
 *   1. Load the target version's snapshot.
 *   2. Load the current document state.
 *   3. Compute a diff (current → target) and apply it as a new Yjs update.
 *   4. Record the restore as a new 'restore' version.
 *
 * This approach preserves linear history — the restore is additive, not
 * destructive.  Active collaborators receive the restore diff as a normal
 * Yjs update and converge automatically.
 *
 * @param fileId     Document identifier
 * @param versionId  Version to restore
 * @param userId     User performing the restore
 * @param applyToRoom  Callback to apply the update to the live Room Y.Doc
 */
export async function restoreVersion(
  fileId: string,
  versionId: string,
  userId: string,
  applyToRoom?: (update: Uint8Array) => void,
): Promise<RestoreResult> {
  try {
    // ── 1. Load target version ────────────────────────────────────────────
    const version = await loadVersion(fileId, versionId);
    if (!version) {
      return { success: false, versionId: null, walSeq: null, bytesApplied: 0, error: 'Version not found' };
    }

    // ── 2. Load current state ─────────────────────────────────────────────
    const currentSnapshot = await loadSnapshot(fileId);
    if (!currentSnapshot) {
      return { success: false, versionId: null, walSeq: null, bytesApplied: 0, error: 'Current state not available' };
    }

    // ── 3. Build the restore delta from current -> target ─────────────────
    // We need delete+insert operations, not just additive state merge,
    // otherwise reverting to an older version can be a no-op.
    const currentDoc = new Y.Doc();
    Y.applyUpdate(currentDoc, new Uint8Array(currentSnapshot));
    const currentSV = Y.encodeStateVector(currentDoc);

    const targetDoc = new Y.Doc();
    try {
      Y.applyUpdateV2(targetDoc, new Uint8Array(version.snapshot));
    } catch {
      Y.applyUpdate(targetDoc, new Uint8Array(version.snapshot));
    }

    const currentRoot = currentDoc.getXmlFragment(ROOT_FRAGMENT_KEY);
    const targetRoot = targetDoc.getXmlFragment(ROOT_FRAGMENT_KEY);

    currentDoc.transact(() => {
      if (currentRoot.length > 0) {
        currentRoot.delete(0, currentRoot.length);
      }
      const cloned = targetRoot.toArray().map((node) => node.clone());
      if (cloned.length > 0) {
        currentRoot.insert(0, cloned as any);
      }
    }, 'restore-version');

    // Delta update to move peers from CURRENT -> RESTORED state.
    const restoreUpdate = Y.encodeStateAsUpdate(currentDoc, currentSV);
    const restoreBuf = Buffer.from(restoreUpdate);

    // ── 4. Persist via WAL ────────────────────────────────────────────────
    const seq = await appendUpdate(fileId, restoreBuf);
    if (seq === null) {
      return { success: false, versionId: null, walSeq: null, bytesApplied: restoreBuf.byteLength, error: 'WAL append failed' };
    }

    // ── 5. Apply to live Room if available ────────────────────────────────
    if (applyToRoom) {
      try {
        applyToRoom(new Uint8Array(restoreUpdate));
      } catch (err) {
        logger.error({ err, fileId, versionId }, '[versionService] failed to apply restore to room');
        // WAL was written — room will catch up on next load.  Non-fatal.
      }
    }

    // ── 6. Record the restored state as a new version ─────────────────────
    const v2Snapshot = Buffer.from(Y.encodeStateAsUpdateV2(currentDoc));
    const newVersionId = await saveVersion({
      fileId,
      snapshot: v2Snapshot,
      source: 'restore',
      label: `Restored from v${version.versionNum}${version.label ? ` (${version.label})` : ''}`,
      createdBy: userId,
    });

    if (newVersionId) {
      versionRestoreTotal.inc();
      versionCapturesTotal.inc({ source: 'restore' });
      versionCaptureBytes.observe(v2Snapshot.byteLength);
    }

    logger.info(
      {
        fileId,
        restoredFrom: versionId,
        restoredBy: userId,
        newVersionId,
        walSeq: String(seq),
        bytes: restoreBuf.byteLength,
      },
      '[versionService] version restored',
    );

    return {
      success: true,
      versionId: newVersionId,
      walSeq: seq,
      bytesApplied: restoreBuf.byteLength,
    };
  } catch (err) {
    logger.error({ err, fileId, versionId }, '[versionService] restoreVersion failed');
    return { success: false, versionId: null, walSeq: null, bytesApplied: 0, error: 'Internal error' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clear in-memory capture state for a file (called when room is evicted).
 */
export function clearCaptureState(fileId: string): void {
  captureStates.delete(fileId);
}

/**
 * Get capture statistics (for admin dashboard / diagnostics).
 */
export function getCaptureStats(): { trackedFiles: number; states: Map<string, CaptureState> } {
  return { trackedFiles: captureStates.size, states: captureStates };
}
