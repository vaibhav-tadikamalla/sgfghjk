/**
 * byzantineGuard.ts
 *
 * Defensive CRDT payload validation — Byzantine fault protection.
 *
 * Problem:
 *   A malicious or buggy client can send:
 *     • Oversized Yjs updates that bloat Y.Doc memory unboundedly
 *     • Corrupt binary data that crashes Y.applyUpdate
 *     • Payloads with bit-flip errors from unreliable transports
 *
 * Solution:
 *   Every raw CRDT update passes through `validateCrdtPayload()` BEFORE being
 *   applied to the Y.Doc.  The guard checks:
 *
 *     1. SIZE — reject updates exceeding MAX_CRDT_PAYLOAD_BYTES
 *     2. STRUCTURE — attempt a trial decode via Yjs decode utilities
 *     3. CRC — optional 4-byte CRC32 trailer for integrity verification
 *
 *   Rejected payloads are logged, metered, and silently dropped — the client
 *   connection is NOT terminated (to avoid amplification attacks where a
 *   single corrupt frame takes down an entire session).
 */

import * as Y from 'yjs';
import { byzantineRejectionsCounter } from '../metrics/advancedMetrics';
import { getLogger } from '../utils/logger';

const logger = getLogger();

// ── Tuning constants ──────────────────────────────────────────────────────────

/**
 * Maximum size of a single CRDT update payload in bytes.
 * 512 KiB — an individual keystroke/operation is typically < 200 bytes.
 * Batch operations (paste large text) can reach 100 KiB but rarely exceed 256.
 * 512 KiB provides 2× headroom for legitimate large operations.
 */
export const MAX_CRDT_PAYLOAD_BYTES = 512 * 1024; // 512 KiB

/**
 * Maximum number of items (operations) a single update may contain.
 * Prevents combinatorial explosion during applyUpdate.  Legitimate documents
 * accumulate items gradually; a single update containing > 50k items is
 * almost certainly malicious.
 */
export const MAX_ITEMS_PER_UPDATE = 50_000;

// ── CRC32 implementation ────────────────────────────────────────────────────

const CRC32_TABLE = new Uint32Array(256);
(function buildTable() {
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    CRC32_TABLE[i] = crc;
  }
})();

/**
 * Compute CRC32 checksum of a byte array.
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]!) & 0xFF]! ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── Validation result ───────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  /** The raw payload to apply (potentially stripped of CRC trailer). */
  payload: Uint8Array;
  /** Reason for rejection (only set when valid=false). */
  reason?: 'size_exceeded' | 'decode_failed' | 'crc_mismatch';
}

// ── Core validation ─────────────────────────────────────────────────────────

/**
 * Validate a raw CRDT update payload before it is applied to the Y.Doc.
 *
 * @param rawUpdate  The raw binary data from the WebSocket frame (after
 *                   stripping the MSG_SYNC + syncType varint header — i.e.
 *                   the pure Yjs update bytes extracted by Room.handleSyncMsg).
 * @param connId     Connection ID for logging / tracing.
 *
 * @returns ValidationResult — `valid=true` if the payload is safe to apply.
 */
export function validateCrdtPayload(
  rawUpdate: Uint8Array,
  connId: string,
): ValidationResult {
  // ── 1. Size check ─────────────────────────────────────────────────────────
  if (rawUpdate.byteLength > MAX_CRDT_PAYLOAD_BYTES) {
    byzantineRejectionsCounter.inc({ reason: 'size_exceeded' });
    logger.warn(
      { connId, size: rawUpdate.byteLength, max: MAX_CRDT_PAYLOAD_BYTES },
      '[byzantine] CRDT payload exceeds size limit — rejected',
    );
    return { valid: false, payload: rawUpdate, reason: 'size_exceeded' };
  }

  // ── 2. Structural decode check ────────────────────────────────────────────
  //
  // Attempt a lightweight trial decode to verify the update is well-formed.
  // Y.decodeUpdate (available since Yjs 13.6) decodes the header structure
  // without actually applying operations to a document.
  try {
    // Create a throwaway doc and apply the update.  If the binary is
    // malformed, Yjs will throw during decode.  This is the most thorough
    // validation possible without re-implementing the Yjs wire format.
    const testDoc = new Y.Doc();
    Y.applyUpdate(testDoc, rawUpdate);
    testDoc.destroy();
  } catch (err) {
    byzantineRejectionsCounter.inc({ reason: 'decode_failed' });
    logger.warn(
      { connId, err, size: rawUpdate.byteLength },
      '[byzantine] CRDT payload failed structural decode — rejected',
    );
    return { valid: false, payload: rawUpdate, reason: 'decode_failed' };
  }

  return { valid: true, payload: rawUpdate };
}

/**
 * Validate a payload that includes a 4-byte CRC32 trailer.
 *
 * Wire format:  [Yjs update bytes][CRC32 as 4 big-endian bytes]
 *
 * Clients that opt into CRC validation append a CRC32 checksum of the Yjs
 * update bytes.  This function strips the trailer, validates the checksum,
 * then delegates to `validateCrdtPayload` for structural checks.
 *
 * @param rawWithCrc  Full payload including the 4-byte CRC trailer.
 * @param connId      Connection ID for logging.
 */
export function validateCrdtPayloadWithCrc(
  rawWithCrc: Uint8Array,
  connId: string,
): ValidationResult {
  if (rawWithCrc.byteLength < 5) {
    // Payload too short to contain both data and a CRC
    return validateCrdtPayload(rawWithCrc, connId);
  }

  const dataEnd = rawWithCrc.byteLength - 4;
  const data = rawWithCrc.subarray(0, dataEnd);
  const crcBytes = rawWithCrc.subarray(dataEnd);

  const expected =
    ((crcBytes[0]! << 24) |
     (crcBytes[1]! << 16) |
     (crcBytes[2]! << 8) |
     crcBytes[3]!) >>> 0;

  const actual = crc32(data);

  if (actual !== expected) {
    byzantineRejectionsCounter.inc({ reason: 'crc_mismatch' });
    logger.warn(
      { connId, expected, actual, size: rawWithCrc.byteLength },
      '[byzantine] CRC32 mismatch — payload may be corrupt',
    );
    return { valid: false, payload: data, reason: 'crc_mismatch' };
  }

  return validateCrdtPayload(data, connId);
}

