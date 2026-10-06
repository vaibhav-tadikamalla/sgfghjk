/**
 * benchmark/BenchmarkSimulatedEditor.ts
 *
 * A simulated editor instrumented for benchmark latency measurement.
 *
 * KEY DIFFERENCES from the production SimulatedEditor:
 *
 * 1. LATENCY MODE (default):
 *    Sends INCREMENTAL Yjs delta updates (Y.encodeStateAsUpdate(ydoc, stateVectorBefore))
 *    so exactly ONE new struct appears per update binary.
 *    This makes (clientID, clock) correlation unambiguous and O(1) per lookup.
 *
 * 2. LOAD MODE:
 *    Sends FULL-STATE updates matching real production SimulatedEditor.ts behaviour
 *    for realistic throughput/load testing. Propagation latency NOT measured.
 *
 * 3. Auth uses `sim-user-` prefix for userId and `sim-` prefix for fileId so
 *    PermissionGateway's simulation bypass triggers — no DB lookup required.
 *
 * 4. On every received MSG_SYNC update (LATENCY mode), calls
 *    propagationTracker.recordReceive() immediately before Y.applyUpdate().
 *
 * 5. Supports pauseEditing() / resumeEditing() for cooldown phase.
 *
 * 6. Exposes getDocFingerprint() for CRDT convergence integrity check.
 *
 * IMPORTANT: This editor does NOT modify production PeerGrid update semantics.
 * The incremental delta is benchmark-specific instrumentation only.
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
   * 'latency' (default): sends incremental delta; enables t1→t2 correlation.
   * 'load': sends full-state updates matching production SimulatedEditor.
   */
  mode?: BenchmarkEditorMode;
}

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
          // Auth — fileId MUST start with 'sim-' for PermissionGateway bypass
          this.ws!.send(JSON.stringify({
            type: 'auth',
            accessToken: this.config.accessToken,
            fileId: this.config.fileId,
          }));
          // Yjs sync step 1
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
          const update = decoding.readVarUint8Array(decoder);

          if (this.mode === 'latency') {
            // t2 captured immediately when bytes arrive; before CRDT processing
            const t2 = performance.now();
            Y.applyUpdate(this.ydoc, update);
            // Pass raw incremental update to tracker; O(1) struct lookup
            this.config.propagationTracker.recordReceive(this.config.editorId, update, t2);
          } else {
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
      // Ignore — JSON control messages (auth_success, ping, etc.)
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
    const source = TEXT_POOL[Math.floor(Math.random() * TEXT_POOL.length)]!;
    const burst = Math.max(1, Math.min(20, Math.floor(5 + Math.random() * 15)));
    const snippet = source.slice(0, burst);
    const insertPos = Math.floor(Math.random() * (ytext.length + 1));

    if (this.mode === 'latency') {
      // ── LATENCY MODE: incremental delta update ──────────────────────────────
      //
      // Capture state vector BEFORE transact. After transact,
      // Y.encodeStateAsUpdate(ydoc, stateVectorBefore) produces binary
      // containing ONLY the one newly created struct. That struct has:
      //   struct.id.client === this.ydoc.clientID
      //   struct.id.clock  === clockBefore
      //
      // recordReceive() in LATENCY mode receives this incremental update and
      // finds the match on the first iteration — O(1), not O(doc size).

      const stateVectorBefore = Y.encodeStateVector(this.ydoc);
      const senderClientId = this.ydoc.clientID;
      const clockBefore = this.ydoc.store.clients.get(senderClientId)?.length ?? 0;
      const t1 = performance.now();

      this.config.propagationTracker.recordSend(
        this.config.editorId,
        senderClientId,
        clockBefore,
        t1,
      );

      this.ydoc.transact(() => {
        ytext.insert(insertPos, snippet);
      });

      // Encode only new structs since stateVectorBefore
      const deltaUpdate = Y.encodeStateAsUpdate(this.ydoc, stateVectorBefore);

      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      encoding.writeVarUint(enc, 2); // messageYjsUpdate
      encoding.writeVarUint8Array(enc, deltaUpdate);
      this.wsSend(encoding.toUint8Array(enc));

    } else {
      // ── LOAD MODE: full-state update (matches production SimulatedEditor.ts) ─
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

  // ── Convergence fingerprint ───────────────────────────────────────────────────

  /**
   * SHA-256 of full Y.Doc state. Used as CRDT integrity check:
   * all editors must match. Expected to always be true in-process
   * (Yjs guarantees it). Failure indicates a software bug.
   *
   * NOTE: this is NOT a distributed partition-recovery test.
   * For that, use the chaos engineering infrastructure separately.
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
