/**
 * benchmark/BenchmarkSimulatedEditor.ts
 *
 * A simulated editor variant instrumented for benchmark latency measurement.
 *
 * Key differences from SimulatedEditor:
 *   1. On every edit, calls propagationTracker.recordSend() BEFORE transact()
 *   2. On every received MSG_SYNC update, calls propagationTracker.recordReceive()
 *      AFTER Y.applyUpdate()
 *   3. Supports pauseEditing() / resumeEditing() for cooldown phase
 *   4. Exposes getDocFingerprint() for convergence verification
 *   5. reconnectProbability defaults to 0 (disabled during benchmarks by default)
 *
 * All Yjs protocol handling is identical to SimulatedEditor — this editor
 * connects via real WebSocket, uses real JWT auth, and speaks the full
 * Yjs sync/awareness protocol.
 *
 * Performance notes:
 *   - Y.decodeUpdate() is called on every received update, which adds ~0.1ms
 *     overhead. This is negligible vs network latency but documented.
 *   - SHA-256 fingerprinting only happens once (during convergence check).
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
}

// Text pool for realistic-ish content
const TEXT_POOL = [
  'The quick brown fox jumps over the lazy dog. ',
  'In distributed systems, consistency and availability are fundamental trade-offs. ',
  'Real-time collaboration requires efficient conflict resolution. ',
  'CRDTs enable eventual consistency without coordination overhead. ',
  'PeerGrid uses Yjs for collaborative document editing at scale. ',
  'Benchmark results depend on network conditions and server load. ',
  'Latency percentiles (p50, p95, p99) reveal tail behavior. ',
  'WebSocket connections provide full-duplex communication channels. ',
  'The system processes thousands of edits per second across multiple nodes. ',
  'Load testing helps identify bottlenecks before they affect users. ',
];

export class BenchmarkSimulatedEditor {
  private readonly config: BenchmarkSimulatedEditorConfig;
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
    this.ydoc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);
  }

  get isConnected(): boolean { return this._connected; }
  get editsGenerated(): number { return this._editsGenerated; }

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

  // ── WebSocket ────────────────────────────────────────────────────────────────

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
          // Auth
          this.ws!.send(JSON.stringify({
            type: 'auth',
            accessToken: this.config.accessToken,
            fileId: this.config.fileId,
          }));
          // Sync step 1
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MSG_SYNC);
          syncProtocol.writeSyncStep1(enc, this.ydoc);
          this.ws!.send(encoding.toUint8Array(enc));
          resolve();
        });

        this.ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
          const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
          const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
          this.handleMessage(uint8);
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

  // ── Message handling ──────────────────────────────────────────────────────────

  private handleMessage(data: Uint8Array): void {
    if (data.length === 0) return;
    try {
      const msgType = data[0]!;

      if (msgType === MSG_SYNC) {
        const decoder = decoding.createDecoder(data);
        decoding.readVarUint(decoder); // consume MSG_SYNC
        const syncType = decoding.readVarUint(decoder);

        if (syncType === syncProtocol.messageYjsSyncStep1) {
          const sv = decoding.readVarUint8Array(decoder);
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MSG_SYNC);
          syncProtocol.writeSyncStep2(enc, this.ydoc, sv);
          this.wsSend(encoding.toUint8Array(enc));
        } else if (syncType === syncProtocol.messageYjsSyncStep2) {
          const update = decoding.readVarUint8Array(decoder);
          Y.applyUpdate(this.ydoc, update);
          if (!this.synced) { this.synced = true; }
        } else if (syncType === syncProtocol.messageYjsUpdate) {
          // ── KEY: measure t2 here ──────────────────────────────────────────
          const update = decoding.readVarUint8Array(decoder);
          const t2 = performance.now();
          Y.applyUpdate(this.ydoc, update);
          // Record receive — tracker extracts clientId/clock from update bytes
          this.config.propagationTracker.recordReceive(this.config.editorId, update, t2);
        }
      } else if (msgType === MSG_AWARENESS) {
        const decoder = decoding.createDecoder(data);
        decoding.readVarUint(decoder);
        const update = decoding.readVarUint8Array(decoder);
        awarenessProtocol.applyAwarenessUpdate(this.awareness, update, null);
      }
    } catch {
      // Ignore (JSON control messages, auth success, etc.)
    }
  }

  private wsSend(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  // ── Edit loop ─────────────────────────────────────────────────────────────────

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
    const pool = TEXT_POOL;
    const source = pool[Math.floor(Math.random() * pool.length)]!;
    const burst = Math.max(1, Math.min(20, Math.floor(5 + Math.random() * 15)));
    const snippet = source.slice(0, burst);
    const insertPos = Math.floor(Math.random() * (ytext.length + 1));

    // ── KEY: capture t1 and clock BEFORE transact ─────────────────────────────
    const senderClientId = this.ydoc.clientID;
    // Get current max clock for this client (before the transact increments it)
    const clientClock = (this.ydoc.store.clients.get(senderClientId)?.length ?? 0);
    const t1 = performance.now();

    this.config.propagationTracker.recordSend(
      this.config.editorId,
      senderClientId,
      clientClock,
      t1,
    );

    // Apply the edit
    this.ydoc.transact(() => {
      ytext.insert(insertPos, snippet);
    });

    // Encode and send as update (messageYjsUpdate = 2)
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    encoding.writeVarUint(enc, 2); // messageYjsUpdate
    // Send only the diff since last encoding
    const stateUpdate = Y.encodeStateAsUpdate(this.ydoc);
    encoding.writeVarUint8Array(enc, stateUpdate);
    this.wsSend(encoding.toUint8Array(enc));

    this._editsGenerated++;
  }

  // ── Convergence fingerprint ───────────────────────────────────────────────────

  /**
   * Returns a SHA-256 hex fingerprint of the current Y.Doc state.
   * Two editors with identical fingerprints have converged.
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
