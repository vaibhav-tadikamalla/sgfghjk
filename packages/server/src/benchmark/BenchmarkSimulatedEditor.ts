/**
 * benchmark/BenchmarkSimulatedEditor.ts
 *
 * A simulated editor instrumented for benchmark latency measurement.
 *
 * CRITICAL: The server (websocket.ts handleAuthMessage) requires the FIRST
 * WebSocket message to be the auth JSON. Any binary message before auth
 * completes causes an immediate close. Therefore:
 *
 *   on('open')    → send auth JSON only
 *   on auth_success → send Yjs syncStep1 binary
 *
 * KEY DIFFERENCES from the production SimulatedEditor:
 *
 * 1. LATENCY MODE (default):
 *    Sends INCREMENTAL Yjs delta updates (Y.encodeStateAsUpdate(ydoc, stateVectorBefore))
 *    so exactly ONE struct appears in the update binary.
 *    Makes (clientID, clock) correlation unambiguous and O(1).
 *
 * 2. LOAD MODE:
 *    Sends FULL-STATE updates matching production SimulatedEditor.ts for load testing.
 *
 * 3. Auth uses sim-user- prefix for userId and sim- prefix for fileId so
 *    PermissionGateway bypass triggers (no DB lookup needed).
 *
 * 4. On every MSG_SYNC update received (LATENCY mode only), calls
 *    propagationTracker.recordReceive() with the exact update bytes.
 *
 * 5. Supports pauseEditing() / resumeEditing() for cooldown phase.
 *
 * 6. Exposes getDocFingerprint() for CRDT convergence integrity check.
 */

import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { createHash } from 'node:crypto';
import { getLogger } from '../utils/logger';
import type { BenchmarkPropagationTracker } from './BenchmarkPropagationTracker';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

/** Operating mode for the benchmark editor. */
export type BenchmarkEditorMode = 'latency' | 'load';

export interface BenchmarkSimulatedEditorConfig {
  editorId: string;
  displayName: string;
  accessToken: string;
  fileId: string;
  wsUrl: string;
  typingSpeed?: number;
  reconnectProbability?: number;
  abortSignal: AbortSignal;
  propagationTracker: BenchmarkPropagationTracker;
  /**
   * 'latency': sends incremental delta updates for reliable t1->t2 correlation.
   * 'load': sends full-state updates matching real SimulatedEditor behaviour.
   * Default: 'latency'.
   */
  mode?: BenchmarkEditorMode;
}

// Text pool for realistic content generation
const TEXT_POOL = [
  'The quick brown fox jumps over the lazy dog. ',
  'In distributed systems, consistency and availability are fundamental trade-offs. ',
  'Real-time collaboration requires efficient conflict resolution. ',
  'CRDTs enable eventual consistency without coordination overhead. ',
  'PeerGrid uses Yjs for collaborative document editing at scale. ',
  'Benchmark results depend on network conditions and server load. ',
  'Latency percentiles (p50, p95, p99) reveal tail behaviour. ',
  'WebSocket connections provide full-duplex communication channels. ',
  'The system processes thousands of edits per second across multiple nodes. ',
  'Load testing helps identify bottlenecks before they affect users. ',
];

export class BenchmarkSimulatedEditor {
  private readonly config: BenchmarkSimulatedEditorConfig;
  private readonly mode: BenchmarkEditorMode;
  private ws: WebSocket | null = null;
  private ydoc: Y.Doc;
  private awareness: awarenessProtocol.Awareness;
  private synced = false;
  private _connected = false;
  private _editsGenerated = 0;
  private _paused = false;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly log = getLogger().child({ component: 'BenchSimEditor' });

  constructor(config: BenchmarkSimulatedEditorConfig) {
    this.config = config;
    this.mode = config.mode ?? 'latency';
    this.ydoc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);
  }

  get isConnected(): boolean { return this._connected; }
  get editsGenerated(): number { return this._editsGenerated; }
  get editorId(): string { return this.config.editorId; }
  get displayName(): string { return this.config.displayName; }

  async start(): Promise<void> {
    if (this.config.abortSignal.aborted) return;
    await this.connect();
    this.scheduleEditLoop();
  }

  stop(): void {
    if (this.loopTimer) { clearTimeout(this.loopTimer); this.loopTimer = null; }
    this.disconnect();
    this._connected = false;
  }

  pauseEditing(): void { this._paused = true; }
  resumeEditing(): void { this._paused = false; }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  private connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.config.abortSignal.aborted) { resolve(); return; }

      try {
        this.ydoc.destroy();
        this.ydoc = new Y.Doc();
        this.awareness = new awarenessProtocol.Awareness(this.ydoc);
        this.synced = false;

        this.ws = new WebSocket(this.config.wsUrl);

        this.ws.on('open', () => {
          this._connected = true;
          // IMPORTANT: Send ONLY the auth JSON here.
          // The server (handleAuthMessage) closes any connection whose first
          // message is binary. Yjs syncStep1 is sent AFTER auth_success arrives.
          this.ws!.send(JSON.stringify({
            type: 'auth',
            accessToken: this.config.accessToken,
            fileId: this.config.fileId, // must start with 'sim-' for PermissionGateway bypass
          }));
          resolve();
        });

        this.ws.on('message', (rawData: Buffer | ArrayBuffer | Buffer[]) => {
          const buf = rawData instanceof Buffer
            ? rawData
            : Buffer.from(rawData as ArrayBuffer);

          // ── JSON control messages ──────────────────────────────────────────
          // auth_success, auth_error, user_joined, ping, etc. are sent as
          // text frames. Check first byte: '{' = 123.
          if (buf.length > 0 && buf[0] === 123) {
            try {
              const msg = JSON.parse(buf.toString('utf8')) as { type?: string };
              if (msg.type === 'auth_success') {
                // Auth complete — now safe to send Yjs syncStep1 binary
                const enc = encoding.createEncoder();
                encoding.writeVarUint(enc, MSG_SYNC);
                syncProtocol.writeSyncStep1(enc, this.ydoc);
                this.wsSend(encoding.toUint8Array(enc));
              }
              // auth_error, user_joined, etc. — no action needed
              return;
            } catch {
              // Not valid JSON, fall through to binary handling
            }
          }

          // ── Binary Yjs messages ────────────────────────────────────────────
          const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
          this.handleBinaryMessage(uint8);
        });

        this.ws.on('close', () => {
          this._connected = false;
          this.synced = false;
        });

        this.ws.on('error', () => {
          this._connected = false;
          resolve();
        });
      } catch {
        this._connected = false;
        resolve();
      }
    });
  }

  private disconnect(): void {
    if (this.ws) {
      try { this.ws.close(1000, 'Benchmark ended'); } catch { /* noop */ }
      this.ws = null;
    }
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private handleBinaryMessage(data: Uint8Array): void {
    if (data.length === 0) return;
    try {
      const msgType = data[0]!;

      if (msgType === MSG_SYNC) {
        const decoder = decoding.createDecoder(data);
        decoding.readVarUint(decoder); // consume MSG_SYNC byte
        const syncType = decoding.readVarUint(decoder);

        if (syncType === syncProtocol.messageYjsSyncStep1) {
          // Server is requesting our state — send syncStep2
          const sv = decoding.readVarUint8Array(decoder);
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MSG_SYNC);
          syncProtocol.writeSyncStep2(enc, this.ydoc, sv);
          this.wsSend(encoding.toUint8Array(enc));
        } else if (syncType === syncProtocol.messageYjsSyncStep2) {
          // Initial sync from server — apply and mark as synced
          const update = decoding.readVarUint8Array(decoder);
          Y.applyUpdate(this.ydoc, update);
          if (!this.synced) { this.synced = true; }
        } else if (syncType === syncProtocol.messageYjsUpdate) {
          // Update broadcast from another client via server
          const update = decoding.readVarUint8Array(decoder);

          if (this.mode === 'latency') {
            // ── LATENCY MODE: capture t2 before applying ─────────────────
            // t2 is the moment raw bytes arrive at this editor (receive time).
            // This matches the academic definition of propagation latency.
            const t2 = performance.now();
            Y.applyUpdate(this.ydoc, update);
            // tracker extracts (clientId, clock) from the incremental update
            this.config.propagationTracker.recordReceive(this.config.editorId, update, t2);
          } else {
            // ── LOAD MODE: just apply, no latency tracking ───────────────
            Y.applyUpdate(this.ydoc, update);
          }
        }
      } else if (msgType === MSG_AWARENESS) {
        const decoder = decoding.createDecoder(data);
        decoding.readVarUint(decoder);
        const update = decoding.readVarUint8Array(decoder);
        awarenessProtocol.applyAwarenessUpdate(this.awareness, update, null);
      }
    } catch {
      // Silently ignore malformed messages
    }
  }

  private wsSend(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  // ── Edit loop ──────────────────────────────────────────────────────────────

  private scheduleEditLoop(): void {
    if (this.config.abortSignal.aborted) return;
    const speed = this.config.typingSpeed ?? 2;
    const baseDelay = 1000 / speed;
    const jitter = 0.5 + Math.random() * 1.5;
    const idleBurst = Math.random() < 0.1 ? (500 + Math.random() * 3000) : 0;
    const delay = baseDelay * jitter + idleBurst;
    this.loopTimer = setTimeout(() => void this.editCycle(), delay);
  }

  private async editCycle(): Promise<void> {
    if (this.config.abortSignal.aborted) return;

    if (!this._paused && this.ws?.readyState === WebSocket.OPEN && this.synced) {
      this.performEdit();
    }

    this.scheduleEditLoop();
  }

  private performEdit(): void {
    const ytext = this.ydoc.getText('default');
    const source = TEXT_POOL[Math.floor(Math.random() * TEXT_POOL.length)]!;
    const burst = Math.max(1, Math.min(20, Math.floor(5 + Math.random() * 15)));
    const snippet = source.slice(0, burst);
    const insertPos = Math.floor(Math.random() * (ytext.length + 1));

    if (this.mode === 'latency') {
      // ── LATENCY MODE: incremental delta ─────────────────────────────────
      //
      // Capture the state vector BEFORE transact. After transact,
      // Y.encodeStateAsUpdate(ydoc, stateVectorBefore) produces a binary
      // containing ONLY the newly created struct with:
      //   struct.id.client === this.ydoc.clientID
      //   struct.id.clock  === clockBefore
      //
      // The tracker looks up (clientId, clockBefore) in the pending map.
      // O(1) lookup — no linear scan of the document.

      const stateVectorBefore = Y.encodeStateVector(this.ydoc);
      const senderClientId = this.ydoc.clientID;
      // IMPORTANT: use the character-clock from the state vector, NOT arr.length.
      // arr.length counts structs; struct.id.clock is the cumulative character position.
      // Y.encodeStateVector encodes {clientId → nextClock} where nextClock = total chars written.
      const clockBefore = Y.decodeStateVector(stateVectorBefore).get(senderClientId) ?? 0;
      const t1 = performance.now();

      // Register with tracker BEFORE sending so t1 is recorded first
      this.config.propagationTracker.recordSend(
        this.config.editorId,
        senderClientId,
        clockBefore,
        t1,
      );

      // Apply edit locally
      this.ydoc.transact(() => {
        ytext.insert(insertPos, snippet);
      });

      // Encode only new structs (delta since stateVectorBefore)
      const deltaUpdate = Y.encodeStateAsUpdate(this.ydoc, stateVectorBefore);

      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      encoding.writeVarUint(enc, 2); // messageYjsUpdate
      encoding.writeVarUint8Array(enc, deltaUpdate);
      this.wsSend(encoding.toUint8Array(enc));

    } else {
      // ── LOAD MODE: full-state update (matches production SimulatedEditor.ts)
      this.ydoc.transact(() => {
        ytext.insert(insertPos, snippet);
      });

      const fullUpdate = Y.encodeStateAsUpdate(this.ydoc);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      encoding.writeVarUint(enc, 2); // messageYjsUpdate
      encoding.writeVarUint8Array(enc, fullUpdate);
      this.wsSend(encoding.toUint8Array(enc));
    }

    this._editsGenerated++;
  }

  // ── Convergence fingerprint ────────────────────────────────────────────────

  /**
   * Returns a SHA-256 hex fingerprint of the current Y.Doc state.
   * Used as a CRDT convergence integrity check:
   *   - Two editors with identical fingerprints have the same document state.
   *   - EXPECTED: all editors converge. Failure indicates a software bug.
   *
   * NOTE: In-process benchmarks will almost always converge because
   * Yjs CRDT guarantees it in the same event loop. This check primarily
   * detects software defects rather than distributed partition scenarios.
   */
  getDocFingerprint(): string {
    try {
      const state = Y.encodeStateAsUpdate(this.ydoc);
      return createHash('sha256').update(Buffer.from(state)).digest('hex');
    } catch {
      return 'error';
    }
  }
}
