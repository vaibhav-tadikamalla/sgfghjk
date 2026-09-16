/**
 * simulator/SimulatedEditor.ts
 *
 * A single simulated editor client that connects via real WebSocket,
 * authenticates with a JWT, and performs realistic CRDT editing behaviour.
 *
 * Each editor follows a human-like pattern:
 *   - typing bursts (5–30 characters at realistic WPM)
 *   - idle periods (1–8 seconds)
 *   - cursor movements / awareness updates
 *   - occasional reconnects
 *
 * All interaction goes through the normal WebSocket protocol — the CRDT
 * pipeline is NOT modified.
 */

import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { getLogger } from '../utils/logger';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export type EditorState = 'connecting' | 'authenticating' | 'syncing' | 'editing' | 'idle' | 'reconnecting' | 'stopped';

export interface SimulatedEditorMetrics {
  editorId: string;
  state: EditorState;
  editsGenerated: number;
  awarenessUpdates: number;
  reconnects: number;
  connectionFailures: number;
  lastEditTimestamp: number;
  latencyMs: number;
}

export interface SimulatedEditorConfig {
  editorId: string;
  displayName: string;
  /** JWT access token (pre-generated). */
  accessToken: string;
  /** Target file/room ID. */
  fileId: string;
  /** Server WebSocket URL (e.g. ws://localhost:4850/ws). */
  wsUrl: string;
  /** Average typing speed in chars/second. */
  typingSpeed?: number;
  /** Probability of reconnecting each cycle (0–1). */
  reconnectProbability?: number;
  /** Signal to stop the editor. */
  abortSignal: AbortSignal;
}

export class SimulatedEditor {
  private readonly config: SimulatedEditorConfig;
  private ws: WebSocket | null = null;
  private ydoc: Y.Doc;
  private awareness: awarenessProtocol.Awareness;
  private _state: EditorState = 'stopped';
  private _editsGenerated = 0;
  private _awarenessUpdates = 0;
  private _reconnects = 0;
  private _connectionFailures = 0;
  private _lastEditTimestamp = 0;
  private _latencyMs = 0;
  private _editLatencies: number[] = [];
  private synced = false;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly log = getLogger().child({ component: 'SimulatedEditor' });

  // Text content pool for realistic typing simulation
  private static readonly TEXT_POOL = [
    'The quick brown fox jumps over the lazy dog. ',
    'In distributed systems, consistency and availability are fundamental trade-offs. ',
    'Real-time collaboration requires efficient conflict resolution. ',
    'CRDTs enable eventual consistency without coordination. ',
    'PeerGrid uses Yjs for collaborative document editing. ',
    'Edge mirrors reduce latency for geographically distributed users. ',
    'WebSocket connections provide full-duplex communication channels. ',
    'Operational transforms and CRDTs are two approaches to concurrent editing. ',
    'The system processes thousands of edits per second across multiple nodes. ',
    'Load testing helps identify bottlenecks before they affect users. ',
    'Each editor maintains a local copy of the shared document state. ',
    'Awareness protocol enables cursor and selection synchronization. ',
    'Network partitions can cause temporary divergence in document state. ',
    'Snapshot persistence ensures durability across server restarts. ',
    'Redis streams enable cross-node replication of CRDT updates. ',
  ];

  constructor(config: SimulatedEditorConfig) {
    this.config = config;
    this.ydoc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);
  }

  get state(): EditorState { return this._state; }

  getMetrics(): SimulatedEditorMetrics {
    return {
      editorId: this.config.editorId,
      state: this._state,
      editsGenerated: this._editsGenerated,
      awarenessUpdates: this._awarenessUpdates,
      reconnects: this._reconnects,
      connectionFailures: this._connectionFailures,
      lastEditTimestamp: this._lastEditTimestamp,
      latencyMs: this._latencyMs,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.config.abortSignal.aborted) return;
    this._state = 'connecting';
    await this.connect();
    this.scheduleEditLoop();
  }

  stop(): void {
    this._state = 'stopped';
    if (this.loopTimer) { clearTimeout(this.loopTimer); this.loopTimer = null; }
    this.disconnect();
  }

  // ── WebSocket connection ──────────────────────────────────────────────────

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
          this._state = 'authenticating';
          // Send auth message
          const authMsg = JSON.stringify({
            type: 'auth',
            accessToken: this.config.accessToken,
            fileId: this.config.fileId,
          });
          this.ws!.send(authMsg);
          this._state = 'syncing';

          // Send sync step 1
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MSG_SYNC);
          syncProtocol.writeSyncStep1(encoder, this.ydoc);
          this.ws!.send(encoding.toUint8Array(encoder));
          resolve();
        });

        this.ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
          const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
          const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
          this.handleServerMessage(uint8);
        });

        this.ws.on('close', () => {
          if (this._state !== 'stopped' && this._state !== 'reconnecting') {
            this._state = 'idle';
          }
        });

        this.ws.on('error', () => {
          this._connectionFailures++;
          if (this._state !== 'stopped') {
            this._state = 'idle';
          }
          resolve(); // don't block on connection failure
        });
      } catch {
        this._connectionFailures++;
        resolve();
      }
    });
  }

  private disconnect(): void {
    if (this.ws) {
      try { this.ws.close(1000, 'Simulation stopped'); } catch { /* noop */ }
      this.ws = null;
    }
  }

  // ── Message handling ──────────────────────────────────────────────────────

  private handleServerMessage(data: Uint8Array): void {
    if (data.length === 0) return;

    // Try to detect if it's a JSON message (text frame)
    // Server may send auth_success, error, etc. as JSON
    try {
      const msgType = data[0]!;

      if (msgType === MSG_SYNC) {
        const decoder = decoding.createDecoder(data);
        decoding.readVarUint(decoder); // consume MSG_SYNC
        const syncType = decoding.readVarUint(decoder);

        if (syncType === syncProtocol.messageYjsSyncStep1) {
          // Server sent syncStep1 — reply with syncStep2
          const stateVector = decoding.readVarUint8Array(decoder);
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MSG_SYNC);
          syncProtocol.writeSyncStep2(encoder, this.ydoc, stateVector);
          this.wsSend(encoding.toUint8Array(encoder));
        } else if (syncType === syncProtocol.messageYjsSyncStep2) {
          // Server sent syncStep2 — apply it
          const update = decoding.readVarUint8Array(decoder);
          Y.applyUpdate(this.ydoc, update);
          if (!this.synced) {
            this.synced = true;
            this._state = 'editing';
          }
        } else if (syncType === syncProtocol.messageYjsUpdate) {
          // Apply update from another user
          const update = decoding.readVarUint8Array(decoder);
          Y.applyUpdate(this.ydoc, update);
        }
      } else if (msgType === MSG_AWARENESS) {
        const decoder = decoding.createDecoder(data);
        decoding.readVarUint(decoder); // consume MSG_AWARENESS
        const update = decoding.readVarUint8Array(decoder);
        awarenessProtocol.applyAwarenessUpdate(this.awareness, update, null);
      }
      // Ignore other message types (ACK, PING, etc.)
    } catch {
      // Ignore parse errors — likely JSON control messages
    }
  }

  private wsSend(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  // ── Edit simulation loop ──────────────────────────────────────────────────

  private scheduleEditLoop(): void {
    if (this.config.abortSignal.aborted || this._state === 'stopped') return;

    const delay = this.getNextActionDelay();
    this.loopTimer = setTimeout(() => {
      void this.performEditCycle();
    }, delay);
  }

  private async performEditCycle(): Promise<void> {
    if (this.config.abortSignal.aborted || this._state === 'stopped') return;

    // Occasional reconnect
    const reconnectProb = this.config.reconnectProbability ?? 0.02;
    if (Math.random() < reconnectProb && this._reconnects < 100) {
      this._state = 'reconnecting';
      this._reconnects++;
      this.disconnect();
      await this.sleep(500 + Math.random() * 2000);
      if (this.config.abortSignal.aborted) return;
      await this.connect();
      this.scheduleEditLoop();
      return;
    }

    // Only edit if connected and synced
    if (this.ws?.readyState === WebSocket.OPEN && this.synced) {
      const action = Math.random();

      if (action < 0.6) {
        // Typing burst — insert 5–30 characters
        this.performTypingBurst();
      } else if (action < 0.85) {
        // Awareness update — cursor movement
        this.sendAwarenessUpdate();
      } else {
        // Idle — just wait (simulates reading/thinking)
        this._state = 'idle';
      }
    }

    this._state = this.ws?.readyState === WebSocket.OPEN ? 'editing' : 'idle';
    this.scheduleEditLoop();
  }

  private performTypingBurst(): void {
    const text = this.getRandomText();
    const burstLen = 5 + Math.floor(Math.random() * 25);
    const snippet = text.slice(0, burstLen);

    const startTime = performance.now();
    const ytext = this.ydoc.getText('default');

    // Insert at a random position within the document
    const docLen = ytext.length;
    const insertPos = Math.floor(Math.random() * (docLen + 1));

    // Apply the edit via Y.Doc transaction — this generates a Yjs update
    this.ydoc.transact(() => {
      ytext.insert(insertPos, snippet);
    });

    // Send the update to the server
    const update = Y.encodeStateAsUpdate(this.ydoc);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    // Send as update (messageYjsUpdate = 2)
    encoding.writeVarUint(encoder, 2); // messageYjsUpdate
    encoding.writeVarUint8Array(encoder, update);
    this.wsSend(encoding.toUint8Array(encoder));

    const latency = performance.now() - startTime;
    this._latencyMs = latency;
    this._editLatencies.push(latency);
    if (this._editLatencies.length > 100) this._editLatencies.shift();

    this._editsGenerated++;
    this._lastEditTimestamp = Date.now();
  }

  private sendAwarenessUpdate(): void {
    const ytext = this.ydoc.getText('default');
    const cursorPos = Math.floor(Math.random() * (ytext.length + 1));

    this.awareness.setLocalStateField('user', {
      name: this.config.displayName,
      color: '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0'),
    });
    this.awareness.setLocalStateField('cursor', {
      anchor: cursorPos,
      head: cursorPos + Math.floor(Math.random() * 10),
    });

    const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
      this.awareness,
      [this.ydoc.clientID],
    );

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessUpdate);
    this.wsSend(encoding.toUint8Array(encoder));

    this._awarenessUpdates++;
  }

  // ── Timing helpers ────────────────────────────────────────────────────────

  private getNextActionDelay(): number {
    const speed = this.config.typingSpeed ?? 5; // chars/sec
    const baseDelay = 1000 / speed;
    // Add jitter: 50% to 200% of base delay
    const jitter = 0.5 + Math.random() * 1.5;
    // Occasionally add a longer idle period (thinking/reading)
    const idleBurst = Math.random() < 0.15 ? (1000 + Math.random() * 7000) : 0;
    return baseDelay * jitter + idleBurst;
  }

  private getRandomText(): string {
    const pool = SimulatedEditor.TEXT_POOL;
    return pool[Math.floor(Math.random() * pool.length)]!;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
