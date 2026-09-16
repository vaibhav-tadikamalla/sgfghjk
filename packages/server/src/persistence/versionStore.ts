/**
 * versionStore.ts
 *
 * Low-level CRUD layer for the `document_versions` PostgreSQL table.
 *
 * Design constraints (matching the rest of the persistence layer):
 *   - All errors are caught and logged; callers are NEVER thrown at.
 *   - All DB operations are non-blocking (async, pool-based).
 *   - Snapshots are stored as V2-encoded Yjs state.
 *   - Deduplication via SHA-256 content hash.
 */

import { createHash } from 'node:crypto';
import { getPool } from '../db/pool';
import { getLogger } from '../utils/logger';

const logger = getLogger();

/** Maximum snapshot size to store as a version (10 MB). */
const MAX_VERSION_BYTES = 10 * 1024 * 1024;

/** Default max versions per document. */
const DEFAULT_MAX_VERSIONS = 100;

/** Default max age for versions (90 days in ms). */
const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentVersion {
  id: string;
  fileId: string;
  versionNum: number;
  label: string | null;
  source: 'auto' | 'manual' | 'restore';
  snapshot: Buffer;
  snapshotHash: string;
  byteSize: number;
  createdBy: string | null;
  createdAt: Date;
}

/** Listing projection — excludes the heavy snapshot bytes. */
export interface DocumentVersionMeta {
  id: string;
  fileId: string;
  versionNum: number;
  label: string | null;
  source: 'auto' | 'manual' | 'restore';
  snapshotHash: string;
  byteSize: number;
  createdBy: string | null;
  createdAt: Date;
}

export interface SaveVersionParams {
  fileId: string;
  snapshot: Buffer;
  source: 'auto' | 'manual' | 'restore';
  label?: string | null;
  createdBy?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hash helper
// ─────────────────────────────────────────────────────────────────────────────

export function hashSnapshot(snapshot: Buffer | Uint8Array): string {
  return createHash('sha256').update(snapshot).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Write path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save a new version for `fileId`.
 *
 * Deduplication: if the snapshot hash already exists for this file,
 * the write is silently skipped and `null` is returned.
 *
 * Returns the created version ID, or null on dedup / error.
 */
export async function saveVersion(params: SaveVersionParams): Promise<string | null> {
  const { fileId, snapshot, source, label, createdBy } = params;

  if (snapshot.byteLength > MAX_VERSION_BYTES) {
    logger.warn(
      { fileId, size: snapshot.byteLength, max: MAX_VERSION_BYTES },
      '[versionStore] skipped — version exceeds size limit',
    );
    return null;
  }

  const snapshotHash = hashSnapshot(snapshot);

  try {
    // ── Dedup check ─────────────────────────────────────────────────────
    const existing = await getPool().query<{ id: string }>(
      `SELECT id FROM document_versions
       WHERE  file_id = $1 AND snapshot_hash = $2
       LIMIT  1`,
      [fileId, snapshotHash],
    );
    if (existing.rows.length > 0) {
      logger.debug(
        { fileId, hash: snapshotHash.slice(0, 12) },
        '[versionStore] skipped — duplicate hash',
      );
      return null;
    }

    // ── Insert ──────────────────────────────────────────────────────────
    const result = await getPool().query<{ id: string }>(
      `INSERT INTO document_versions (file_id, label, source, snapshot, snapshot_hash, byte_size, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id::text AS id`,
      [fileId, label ?? null, source, snapshot, snapshotHash, snapshot.byteLength, createdBy ?? null],
    );

    const versionId = result.rows[0]!.id;
    logger.info(
      { fileId, versionId, source, bytes: snapshot.byteLength, hash: snapshotHash.slice(0, 12) },
      '[versionStore] version saved',
    );
    return versionId;
  } catch (err) {
    logger.error({ err, fileId, source }, '[versionStore] saveVersion failed');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List version metadata for a file (newest first).
 * Excludes snapshot bytes for efficiency.
 */
export async function listVersions(
  fileId: string,
  limit = 50,
  offset = 0,
): Promise<{ versions: DocumentVersionMeta[]; total: number }> {
  try {
    const [metaResult, countResult] = await Promise.all([
      getPool().query<{
        id: string;
        file_id: string;
        version_num: number;
        label: string | null;
        source: string;
        snapshot_hash: string;
        byte_size: number;
        created_by: string | null;
        created_at: Date;
      }>(
        `SELECT id::text, file_id, version_num, label, source, snapshot_hash, byte_size, created_by::text, created_at
         FROM   document_versions
         WHERE  file_id = $1
         ORDER  BY created_at DESC
         LIMIT  $2 OFFSET $3`,
        [fileId, limit, offset],
      ),
      getPool().query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM document_versions WHERE file_id = $1`,
        [fileId],
      ),
    ]);

    return {
      versions: metaResult.rows.map(mapMetaRow),
      total: parseInt(countResult.rows[0]!.count, 10),
    };
  } catch (err) {
    logger.error({ err, fileId }, '[versionStore] listVersions failed');
    return { versions: [], total: 0 };
  }
}

/**
 * Load a single version including the snapshot bytes.
 */
export async function loadVersion(
  fileId: string,
  versionId: string,
): Promise<DocumentVersion | null> {
  try {
    const result = await getPool().query<{
      id: string;
      file_id: string;
      version_num: number;
      label: string | null;
      source: string;
      snapshot: Buffer;
      snapshot_hash: string;
      byte_size: number;
      created_by: string | null;
      created_at: Date;
    }>(
      `SELECT id::text, file_id, version_num, label, source, snapshot, snapshot_hash, byte_size, created_by::text, created_at
       FROM   document_versions
       WHERE  file_id = $1 AND id = $2`,
      [fileId, versionId],
    );

    if (result.rows.length === 0) return null;
    const row = result.rows[0]!;
    return {
      id: row.id,
      fileId: row.file_id,
      versionNum: row.version_num,
      label: row.label,
      source: row.source as DocumentVersion['source'],
      snapshot: row.snapshot,
      snapshotHash: row.snapshot_hash,
      byteSize: row.byte_size,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  } catch (err) {
    logger.error({ err, fileId, versionId }, '[versionStore] loadVersion failed');
    return null;
  }
}

/**
 * Load the latest version (for diff base comparison).
 */
export async function loadLatestVersion(fileId: string): Promise<DocumentVersionMeta | null> {
  try {
    const result = await getPool().query<{
      id: string;
      file_id: string;
      version_num: number;
      label: string | null;
      source: string;
      snapshot_hash: string;
      byte_size: number;
      created_by: string | null;
      created_at: Date;
    }>(
      `SELECT id::text, file_id, version_num, label, source, snapshot_hash, byte_size, created_by::text, created_at
       FROM   document_versions
       WHERE  file_id = $1
       ORDER  BY created_at DESC
       LIMIT  1`,
      [fileId],
    );

    if (result.rows.length === 0) return null;
    return mapMetaRow(result.rows[0]!);
  } catch (err) {
    logger.error({ err, fileId }, '[versionStore] loadLatestVersion failed');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Retention / pruning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prune excess versions for a file based on count and age limits.
 * Returns the number of versions pruned.
 */
export async function pruneVersions(
  fileId: string,
  maxVersions = DEFAULT_MAX_VERSIONS,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
): Promise<number> {
  try {
    // ── 1. Prune by age ─────────────────────────────────────────────────
    const cutoff = new Date(Date.now() - maxAgeMs);
    const ageResult = await getPool().query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM document_versions
         WHERE  file_id = $1
           AND  created_at < $2
           AND  source = 'auto'
         RETURNING 1
       )
       SELECT COUNT(*)::text AS count FROM deleted`,
      [fileId, cutoff],
    );
    const agePruned = parseInt(ageResult.rows[0]!.count, 10);

    // ── 2. Prune by count (keep newest maxVersions) ─────────────────────
    const countResult = await getPool().query<{ count: string }>(
      `WITH excess AS (
         SELECT id FROM document_versions
         WHERE  file_id = $1
         ORDER  BY created_at DESC
         OFFSET $2
       ),
       deleted AS (
         DELETE FROM document_versions
         WHERE  id IN (SELECT id FROM excess)
           AND  source = 'auto'
         RETURNING 1
       )
       SELECT COUNT(*)::text AS count FROM deleted`,
      [fileId, maxVersions],
    );
    const countPruned = parseInt(countResult.rows[0]!.count, 10);

    const total = agePruned + countPruned;
    if (total > 0) {
      logger.info(
        { fileId, agePruned, countPruned, total },
        '[versionStore] pruned versions',
      );
    }
    return total;
  } catch (err) {
    logger.error({ err, fileId }, '[versionStore] pruneVersions failed');
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Row mapper
// ─────────────────────────────────────────────────────────────────────────────

function mapMetaRow(row: {
  id: string;
  file_id: string;
  version_num: number;
  label: string | null;
  source: string;
  snapshot_hash: string;
  byte_size: number;
  created_by: string | null;
  created_at: Date;
}): DocumentVersionMeta {
  return {
    id: row.id,
    fileId: row.file_id,
    versionNum: row.version_num,
    label: row.label,
    source: row.source as DocumentVersionMeta['source'],
    snapshotHash: row.snapshot_hash,
    byteSize: row.byte_size,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
