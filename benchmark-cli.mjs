#!/usr/bin/env node
/**
 * benchmark-cli.mjs
 *
 * EXTERNAL PeerGrid Benchmark Runner
 * ====================================
 *
 * PURPOSE:
 *   Runs simulated editors from YOUR LAPTOP against a local or deployed PeerGrid
 *   server. Because this process is separate from the server, CPU and memory
 *   measurements on the server side are NOT contaminated by the benchmark runner.
 *
 *   This is the preferred mode for RESEARCH-QUALITY measurements.
 *
 * LABELING:
 *   Results from this CLI are labeled "End-to-end deployed PeerGrid benchmark"
 *   when targeting a deployed instance, or "External local benchmark" for localhost.
 *   They are NOT labeled as "In-process" results.
 *
 * USAGE:
 *   node benchmark-cli.mjs [options]
 *
 * OPTIONS:
 *   --target   <url>    WebSocket URL to benchmark (required)
 *                       e.g. ws://localhost:3001/ws
 *                       e.g. wss://peergriddemo-api.onrender.com/ws
 *   --users    <n>      Number of concurrent simulated users (default: 5)
 *   --duration <s>      Measurement phase duration in seconds (default: 60)
 *   --warmup   <s>      Warm-up phase in seconds (default: 15)
 *   --cooldown <s>      Cooldown phase in seconds (default: 10)
 *   --speed    <n>      Typing speed in chars/sec (default: 2)
 *   --mode     latency|load  latency=incremental delta (default), load=full state
 *   --matrix            Run academic matrix: users 1,5,10,20,30,40,50 x speeds 1,2,4,8
 *   --users-matrix <list>   Comma-separated user counts for matrix (default: 1,5,10,20,30,40,50)
 *   --speed-matrix <list>   Comma-separated typing speeds for matrix (default: 1,2,4,8)
 *   --spawn-delay <ms>  Delay between spawning each editor (default: 100)
 *   --output   <path>   Write results as JSON to this file
 *   --api-url  <url>    PeerGrid API URL for result upload (optional)
 *   --api-token <tok>   Admin token for result upload (optional)
 *   --no-color          Disable coloured terminal output
 *   --help              Show this help
 *
 * RESULT UPLOAD:
 *   If --api-url and --api-token are set, results are POST-ed to
 *   POST <api-url>/admin/benchmark/external-result
 *   so they appear in the Admin Dashboard alongside in-process results.
 *
 * METHODOLOGY NOTE:
 *   - t1 = performance.now() BEFORE Y.Doc.transact() on sending editor (this process)
 *   - t2 = performance.now() AFTER Y.applyUpdate() on receiving editor (this process)
 *   - Both editors run in THIS process, so performance.now() comparisons are valid.
 *   - WAN latency is measured end-to-end through the deployed server's WebSocket stack.
 *   - This is NOT an exact replication of Dang & Ignat (2016) which used separate
 *     physical machines. It is an adaptation using the same t1/t2 concept.
 *
 * LIMITATIONS:
 *   - All simulated editors run in the same Node.js process (this laptop process).
 *   - Laptop CPU/memory are NOT representative of server-side resource usage.
 *   - Use server-side Prometheus metrics (GET <api-url>/metrics) for server resources.
 *
 * REQUIREMENTS:
 *   Run from the PeerGridDemo-main directory:
 *     node benchmark-cli.mjs --target wss://peergriddemo-api.onrender.com/ws --users 5 --duration 30
 */

import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// ── ANSI colours ──────────────────────────────────────────────────────────────

const NO_COLOR = process.argv.includes('--no-color') || process.env['NO_COLOR'];
const c = {
  reset: NO_COLOR ? '' : '\x1b[0m',
  bold: NO_COLOR ? '' : '\x1b[1m',
  dim: NO_COLOR ? '' : '\x1b[2m',
  green: NO_COLOR ? '' : '\x1b[32m',
  yellow: NO_COLOR ? '' : '\x1b[33m',
  red: NO_COLOR ? '' : '\x1b[31m',
  cyan: NO_COLOR ? '' : '\x1b[36m',
  blue: NO_COLOR ? '' : '\x1b[34m',
  magenta: NO_COLOR ? '' : '\x1b[35m',
};

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  const has = (flag) => args.includes(flag);

  if (has('--help') || has('-h')) {
    const text = process.argv[1].split(/[/\\]/).pop();
    console.log(`Usage: node ${text} [options]`);
    console.log('\nRequired:');
    console.log('  --target <url>         WebSocket URL (ws:// or wss://)');
    console.log('\nOptional:');
    console.log('  --users <n>            Concurrent users (default: 5)');
    console.log('  --duration <s>         Measurement seconds (default: 60)');
    console.log('  --warmup <s>           Warm-up seconds (default: 15)');
    console.log('  --cooldown <s>         Cooldown seconds (default: 10)');
    console.log('  --speed <n>            Chars/sec per user (default: 2)');
    console.log('  --mode latency|load    latency=incremental (default), load=full state');
    console.log('  --matrix               Run academic matrix (users × speeds)');
    console.log('  --users-matrix <list>  Comma-separated user counts for matrix');
    console.log('  --speed-matrix <list>  Comma-separated speeds for matrix');
    console.log('  --spawn-delay <ms>     ms between spawning users (default: 100)');
    console.log('  --output <path>        Save results JSON to file');
    console.log('  --api-url <url>        Upload results to PeerGrid API');
    console.log('  --api-token <token>    Admin token for upload');
    console.log('  --no-color             Disable colours');
    process.exit(0);
  }

  return {
    target: get('--target'),
    users: parseInt(get('--users') ?? '5', 10),
    duration: parseInt(get('--duration') ?? '60', 10),
    warmup: parseInt(get('--warmup') ?? '15', 10),
    cooldown: parseInt(get('--cooldown') ?? '10', 10),
    speed: parseFloat(get('--speed') ?? '2'),
    mode: get('--mode') ?? 'latency',
    matrix: has('--matrix'),
    usersMatrix: (get('--users-matrix') ?? '1,5,10,20,30,40,50').split(',').map(Number),
    speedMatrix: (get('--speed-matrix') ?? '1,2,4,8').split(',').map(Number),
    spawnDelay: parseInt(get('--spawn-delay') ?? '100', 10),
    output: get('--output'),
    apiUrl: get('--api-url'),
    apiToken: get('--api-token'),
  };
}

// ── Statistics ────────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeStats(samples) {
  if (samples.length === 0) {
    return { sampleCount: 0, minMs: 0, maxMs: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, p95Ms: 0, p99Ms: 0, stddevMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
  return {
    sampleCount: samples.length,
    minMs: Math.round(sorted[0] * 100) / 100,
    maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
    meanMs: Math.round(mean * 100) / 100,
    p50Ms: Math.round(percentile(sorted, 50) * 100) / 100,
    p90Ms: Math.round(percentile(sorted, 90) * 100) / 100,
    p95Ms: Math.round(percentile(sorted, 95) * 100) / 100,
    p99Ms: Math.round(percentile(sorted, 99) * 100) / 100,
    stddevMs: Math.round(Math.sqrt(variance) * 100) / 100,
  };
}

// ── Propagation Tracker ───────────────────────────────────────────────────────

class PropagationTracker {
  constructor() {
    this.pending = new Map();
    this.samples = [];
    this.timedOut = 0;
    this.active = false;
    this._timer = setInterval(() => this._sweep(), 2000).unref();
  }

  activate() { this.active = true; }
  deactivate() { this.active = false; }
  dispose() { clearInterval(this._timer); }

  recordSend(editorId, clientId, clock, t1) {
    if (!this.active) return;
    this.pending.set(`${clientId}:${clock}`, { editorId, t1, at: Date.now() });
  }

  recordReceive(receiverEditorId, update, t2) {
    if (!this.active) return;
    try {
      const decoded = Y.decodeUpdate(update);
      for (const struct of decoded.structs) {
        const key = `${struct.id.client}:${struct.id.clock}`;
        const p = this.pending.get(key);
        if (p) {
          this.pending.delete(key);
          const latencyMs = t2 - p.t1;
          if (latencyMs >= 0) {
            this.samples.push(latencyMs);
          }
          return;
        }
      }
    } catch { /* ignore */ }
  }

  _sweep() {
    const now = Date.now();
    for (const [k, v] of this.pending) {
      if (now - v.at > 10_000) { this.pending.delete(k); this.timedOut++; }
    }
  }
}

// ── Simulated Editor ──────────────────────────────────────────────────────────

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

const TEXT_POOL = [
  'The quick brown fox jumps over the lazy dog. ',
  'In distributed systems, consistency and availability are trade-offs. ',
  'Real-time collaboration requires efficient conflict resolution. ',
  'CRDTs enable eventual consistency without coordination overhead. ',
  'PeerGrid uses Yjs for collaborative document editing at scale. ',
  'Benchmark results depend on network conditions and server load. ',
  'Latency percentiles reveal tail behaviour under concurrent load. ',
  'WebSocket connections provide full-duplex communication channels. ',
  'Load testing helps identify bottlenecks before they affect users. ',
];

class BenchmarkEditor {
  constructor({ editorId, accessToken, fileId, wsUrl, typingSpeed, mode, tracker, signal }) {
    this.editorId = editorId;
    this.accessToken = accessToken;
    this.fileId = fileId;
    this.wsUrl = wsUrl;
    this.typingSpeed = typingSpeed ?? 2;
    this.mode = mode ?? 'latency';
    this.tracker = tracker;
    this.signal = signal;
    this.ws = null;
    this.ydoc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);
    this.synced = false;
    this.connected = false;
    this.edits = 0;
    this.paused = false;
    this._timer = null;
  }

  async start() {
    if (this.signal.aborted) return;
    await this._connect();
    this._schedule();
  }

  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this.ws) {
      try { this.ws.close(1000, 'done'); } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  fingerprint() {
    try {
      const s = Y.encodeStateAsUpdate(this.ydoc);
      return createHash('sha256').update(Buffer.from(s)).digest('hex');
    } catch { return 'error'; }
  }

  _connect() {
    return new Promise(resolve => {
      if (this.signal.aborted) return resolve();
      try {
        this.ydoc.destroy();
        this.ydoc = new Y.Doc();
        this.awareness = new awarenessProtocol.Awareness(this.ydoc);
        this.synced = false;
        this.ws = new WebSocket(this.wsUrl);

        this.ws.on('open', () => {
          this.connected = true;
          this.ws.send(JSON.stringify({ type: 'auth', accessToken: this.accessToken, fileId: this.fileId }));
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MSG_SYNC);
          syncProtocol.writeSyncStep1(enc, this.ydoc);
          this.ws.send(encoding.toUint8Array(enc));
          resolve();
        });

        this.ws.on('message', data => {
          const buf = data instanceof Buffer ? data : Buffer.from(data);
          const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
          this._handleMsg(uint8);
        });

        this.ws.on('close', () => { this.connected = false; this.synced = false; });
        this.ws.on('error', () => { this.connected = false; resolve(); });
      } catch { this.connected = false; resolve(); }
    });
  }

  _handleMsg(data) {
    if (!data.length) return;
    try {
      const msgType = data[0];
      if (msgType === MSG_SYNC) {
        const dec = decoding.createDecoder(data);
        decoding.readVarUint(dec);
        const syncType = decoding.readVarUint(dec);
        if (syncType === syncProtocol.messageYjsSyncStep1) {
          const sv = decoding.readVarUint8Array(dec);
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MSG_SYNC);
          syncProtocol.writeSyncStep2(enc, this.ydoc, sv);
          this.ws?.send(encoding.toUint8Array(enc));
        } else if (syncType === syncProtocol.messageYjsSyncStep2) {
          Y.applyUpdate(this.ydoc, decoding.readVarUint8Array(dec));
          if (!this.synced) this.synced = true;
        } else if (syncType === syncProtocol.messageYjsUpdate) {
          const update = decoding.readVarUint8Array(dec);
          if (this.mode === 'latency') {
            const t2 = performance.now();
            Y.applyUpdate(this.ydoc, update);
            this.tracker.recordReceive(this.editorId, update, t2);
          } else {
            Y.applyUpdate(this.ydoc, update);
          }
        }
      } else if (msgType === MSG_AWARENESS) {
        const dec = decoding.createDecoder(data);
        decoding.readVarUint(dec);
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), null);
      }
    } catch {}
  }

  _schedule() {
    if (this.signal.aborted) return;
    const base = 1000 / this.typingSpeed;
    const delay = base * (0.5 + Math.random() * 1.5) + (Math.random() < 0.1 ? 500 + Math.random() * 3000 : 0);
    this._timer = setTimeout(() => { this._cycle(); }, delay);
  }

  _cycle() {
    if (this.signal.aborted) return;
    if (!this.paused && this.ws?.readyState === WebSocket.OPEN && this.synced) {
      this._edit();
    }
    this._schedule();
  }

  _edit() {
    const ytext = this.ydoc.getText('default');
    const src = TEXT_POOL[Math.floor(Math.random() * TEXT_POOL.length)];
    const snippet = src.slice(0, Math.max(1, Math.min(20, Math.floor(5 + Math.random() * 15))));
    const pos = Math.floor(Math.random() * (ytext.length + 1));

    if (this.mode === 'latency') {
      const sv = Y.encodeStateVector(this.ydoc);
      const clientId = this.ydoc.clientID;
      const clock = this.ydoc.store.clients.get(clientId)?.length ?? 0;
      const t1 = performance.now();
      this.tracker.recordSend(this.editorId, clientId, clock, t1);
      this.ydoc.transact(() => { ytext.insert(pos, snippet); });
      const delta = Y.encodeStateAsUpdate(this.ydoc, sv);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      encoding.writeVarUint(enc, 2);
      encoding.writeVarUint8Array(enc, delta);
      this.ws?.send(encoding.toUint8Array(enc));
    } else {
      this.ydoc.transact(() => { ytext.insert(pos, snippet); });
      const full = Y.encodeStateAsUpdate(this.ydoc);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      encoding.writeVarUint(enc, 2);
      encoding.writeVarUint8Array(enc, full);
      this.ws?.send(encoding.toUint8Array(enc));
    }
    this.edits++;
  }
}

// ── JWT builder (minimal RS256-less HS256 for local; or use API to generate) ──
// For external CLI we need tokens. We use the PeerGrid API if --api-url is set,
// or we build a fake-but-signed token using the server's JWT mechanism.
// SIMPLEST approach: we build an unsigned "bearer" in dev, or use
// a pre-shared approach. Since we need real JWT, we use the /auth/test-token
// endpoint if available, otherwise we prompt.

async function getTokens(userCount, apiUrl, apiToken, wsUrl) {
  // Strategy: if --api-url and --api-token are provided, ask the server to
  // generate benchmark tokens for us via a dedicated endpoint.
  // Otherwise, for local dev, the server's sim-user-* bypass works with
  // any JWT that has 'sub' = 'sim-user-...' and passes signature check.
  // We cannot sign JWTs here without the private key.
  //
  // Best path: Use the API server to generate tokens.

  if (!apiUrl || !apiToken) {
    console.warn(`${c.yellow}⚠ No --api-url/--api-token provided.${c.reset}`);
    console.warn(`  The external CLI needs the server to mint JWT tokens for simulated users.`);
    console.warn(`  Provide --api-url <url> --api-token <token> to enable token generation.`);
    console.warn(`  Example: --api-url http://localhost:3001 --api-token <ADMIN_SECRET>`);
    throw new Error('Cannot run external benchmark without --api-url and --api-token (needed for JWT minting).');
  }

  const tokens = [];
  for (let i = 0; i < userCount; i++) {
    const res = await fetch(`${apiUrl}/admin/benchmark/mint-token`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ editorIndex: i + 1 }),
    });
    if (!res.ok) {
      throw new Error(`Failed to mint token for editor ${i + 1}: HTTP ${res.status} ${await res.text()}`);
    }
    const { token, fileId } = await res.json();
    tokens.push({ token, fileId });
  }
  return tokens;
}

// ── Single run ────────────────────────────────────────────────────────────────

async function runBenchmark({ target, users, duration, warmup, cooldown, speed, mode, spawnDelay, apiUrl, apiToken, label }) {
  const runId = randomUUID();
  const fileId = `sim-ext-bench-${runId.slice(0, 8)}`;

  console.log(`\n${c.bold}${c.cyan}┌─────────────────────────────────────────┐${c.reset}`);
  console.log(`${c.bold}${c.cyan}│  External PeerGrid Benchmark Runner     │${c.reset}`);
  console.log(`${c.bold}${c.cyan}└─────────────────────────────────────────┘${c.reset}`);
  console.log(`${c.dim}  Label   :${c.reset} ${label ?? 'External benchmark'}`);
  console.log(`${c.dim}  Target  :${c.reset} ${target}`);
  console.log(`${c.dim}  Users   :${c.reset} ${users}`);
  console.log(`${c.dim}  Duration:${c.reset} ${duration}s (warmup: ${warmup}s, cooldown: ${cooldown}s)`);
  console.log(`${c.dim}  Speed   :${c.reset} ${speed} chars/s per user`);
  console.log(`${c.dim}  Mode    :${c.reset} ${mode}`);
  console.log(`${c.dim}  Room    :${c.reset} ${fileId}`);
  if (mode === 'load') {
    console.log(`${c.yellow}  Note: load mode — propagation latency NOT measured.${c.reset}`);
  }

  // Mint tokens
  console.log(`\n${c.dim}  Minting ${users} JWT tokens via API...${c.reset}`);
  let tokenData;
  try {
    tokenData = await getTokens(users, apiUrl, apiToken, target);
  } catch (err) {
    console.error(`${c.red}✗ Token minting failed: ${err.message}${c.reset}`);
    process.exit(1);
  }
  console.log(`${c.green}  ✓ Tokens minted${c.reset}`);

  const tracker = new PropagationTracker();
  const abort = new AbortController();
  const editors = [];

  // Spawn editors
  console.log(`\n${c.bold}[Phase 1/4] WARM-UP${c.reset} (${warmup}s)`);
  for (let i = 0; i < users; i++) {
    const ed = new BenchmarkEditor({
      editorId: `ext-editor-${i + 1}`,
      accessToken: tokenData[i].token,
      fileId: tokenData[i].fileId ?? fileId,
      wsUrl: target,
      typingSpeed: speed,
      mode,
      tracker,
      signal: abort.signal,
    });
    editors.push(ed);
    ed.start().catch(() => {});
    if (spawnDelay > 0 && i < users - 1) {
      await sleep(spawnDelay);
    }
  }

  await sleep(warmup * 1000);

  const connected = editors.filter(e => e.connected).length;
  console.log(`  ${c.green}✓${c.reset} ${connected}/${users} editors connected`);

  // Measurement
  console.log(`\n${c.bold}[Phase 2/4] MEASUREMENT${c.reset} (${duration}s)`);
  tracker.activate();
  const measureStart = performance.now();

  const statusInterval = setInterval(() => {
    const samples = tracker.samples;
    if (samples.length >= 10) {
      const sorted = [...samples].sort((a, b) => a - b);
      const p50 = Math.round(percentile(sorted, 50) * 10) / 10;
      const p95 = Math.round(percentile(sorted, 95) * 10) / 10;
      const edits = editors.reduce((s, e) => s + e.edits, 0);
      process.stdout.write(`\r  samples=${samples.length} p50=${p50}ms p95=${p95}ms edits=${edits}   `);
    }
  }, 2000);

  await sleep(duration * 1000);
  clearInterval(statusInterval);
  process.stdout.write('\n');
  tracker.deactivate();
  const measureMs = performance.now() - measureStart;

  // Cooldown
  console.log(`\n${c.bold}[Phase 3/4] COOLDOWN${c.reset} (${cooldown}s)`);
  for (const ed of editors) ed.pause();
  await sleep(cooldown * 1000);

  // Convergence
  console.log(`\n${c.bold}[Phase 4/4] CONVERGENCE CHECK${c.reset}`);
  const prints = editors.map(e => e.fingerprint());
  const allSame = prints.length > 0 && prints.every(p => p === prints[0]);

  // Stop all editors
  abort.abort();
  for (const ed of editors) ed.stop();
  tracker.dispose();

  // Compute results
  const latencies = tracker.samples;
  const stats = computeStats(latencies);
  const opsAttempted = editors.reduce((s, e) => s + e.edits, 0);
  const opsPropagated = latencies.length;
  const successRate = opsAttempted > 0 ? opsPropagated / opsAttempted : 0;

  const results = {
    runId,
    label: label ?? 'External benchmark',
    environment: 'external',
    target,
    mode,
    config: { users, duration, warmup, cooldown, speed, spawnDelay },
    measurementDurationMs: Math.round(measureMs),
    latency: stats,
    opsAttempted,
    opsPropagated,
    opsTimedOut: tracker.timedOut,
    successRate: Math.round(successRate * 10000) / 10000,
    errorRate: Math.round((1 - successRate) * 10000) / 10000,
    propagatedOpsPerSec: Math.round((opsPropagated / (measureMs / 1000)) * 100) / 100,
    convergenceAchieved: allSame && prints.length > 0,
    convergenceFingerprints: prints,
    timestamp: new Date().toISOString(),
  };

  // Print results
  console.log(`\n${c.bold}${c.green}═══ RESULTS ═══════════════════════════════════${c.reset}`);
  console.log(`  ${c.bold}Measurement duration:${c.reset} ${Math.round(measureMs)}ms`);
  if (mode === 'latency') {
    console.log(`\n  ${c.bold}Edit Propagation Latency (end-to-end, external):${c.reset}`);
    console.log(`    Samples : ${stats.sampleCount}`);
    console.log(`    Min     : ${stats.minMs}ms`);
    console.log(`    Mean    : ${stats.meanMs}ms`);
    console.log(`    p50     : ${c.green}${stats.p50Ms}ms${c.reset}`);
    console.log(`    p90     : ${stats.p90Ms}ms`);
    console.log(`    p95     : ${c.yellow}${stats.p95Ms}ms${c.reset}`);
    console.log(`    p99     : ${stats.p99Ms}ms`);
    console.log(`    Max     : ${stats.maxMs}ms`);
    console.log(`    StdDev  : ${stats.stddevMs}ms`);
  } else {
    console.log(`  ${c.bold}(load mode — latency not measured)${c.reset}`);
  }
  console.log(`\n  ${c.bold}Operations:${c.reset}`);
  console.log(`    Attempted  : ${opsAttempted}`);
  console.log(`    Propagated : ${opsPropagated}`);
  console.log(`    Timed out  : ${tracker.timedOut}`);
  console.log(`    Success    : ${Math.round(successRate * 100)}%`);
  console.log(`    Throughput : ${results.propagatedOpsPerSec} ops/s`);
  console.log(`\n  ${c.bold}Convergence:${c.reset} ${allSame ? c.green + '✓ All editors converged' : c.red + '✗ Diverged'} ${c.reset}`);

  const researchNote = mode === 'latency'
    ? 'End-to-end deployed PeerGrid benchmark (external process, WAN latency included)'
    : 'End-to-end deployed PeerGrid load test (external process)';
  console.log(`\n  ${c.dim}Label: ${researchNote}${c.reset}`);
  console.log(`  ${c.dim}Note: Dang & Ignat (2016) methodology reference — adaptation, not exact replication.${c.reset}`);
  console.log(`${c.bold}${c.green}════════════════════════════════════════════════${c.reset}\n`);

  return results;
}

// ── Matrix run ────────────────────────────────────────────────────────────────

async function runMatrix({ target, usersMatrix, speedMatrix, duration, warmup, cooldown, mode, spawnDelay, apiUrl, apiToken }) {
  const allResults = [];
  const total = usersMatrix.length * speedMatrix.length;
  let done = 0;

  console.log(`\n${c.bold}${c.magenta}ACADEMIC MATRIX RUN${c.reset}`);
  console.log(`  Users  : ${usersMatrix.join(', ')}`);
  console.log(`  Speeds : ${speedMatrix.join(', ')} chars/s`);
  console.log(`  Total  : ${total} runs\n`);

  for (const speed of speedMatrix) {
    for (const users of usersMatrix) {
      done++;
      console.log(`${c.dim}[${done}/${total}]${c.reset} users=${users} speed=${speed}`);
      const label = `External matrix: ${users} users @ ${speed} chars/s`;
      try {
        const res = await runBenchmark({ target, users, duration, warmup, cooldown, speed, mode, spawnDelay, apiUrl, apiToken, label });
        allResults.push(res);
      } catch (err) {
        console.error(`${c.red}  ✗ Run failed: ${err.message}${c.reset}`);
        allResults.push({ error: err.message, users, speed });
      }
      // Brief pause between matrix cells
      if (done < total) {
        console.log(`  Cooling down 10s before next run...`);
        await sleep(10_000);
      }
    }
  }

  return allResults;
}

// ── Upload results to PeerGrid API ────────────────────────────────────────────

async function uploadResults(results, apiUrl, apiToken) {
  const payload = Array.isArray(results) ? results : [results];
  try {
    const res = await fetch(`${apiUrl}/admin/benchmark/external-result`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: payload }),
    });
    if (res.ok) {
      console.log(`${c.green}✓ Results uploaded to Admin Dashboard${c.reset}`);
    } else {
      console.warn(`${c.yellow}⚠ Upload returned HTTP ${res.status} — results not saved to dashboard${c.reset}`);
    }
  } catch (err) {
    console.warn(`${c.yellow}⚠ Upload failed: ${err.message}${c.reset}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs();

  if (!args.target) {
    console.error(`${c.red}✗ --target is required.${c.reset}`);
    console.error(`  Example: node benchmark-cli.mjs --target ws://localhost:3001/ws --users 2 --duration 30`);
    process.exit(1);
  }

  if (!args.target.startsWith('ws://') && !args.target.startsWith('wss://')) {
    console.error(`${c.red}✗ --target must be a ws:// or wss:// URL.${c.reset}`);
    process.exit(1);
  }

  if (args.mode !== 'latency' && args.mode !== 'load') {
    console.error(`${c.red}✗ --mode must be 'latency' or 'load'.${c.reset}`);
    process.exit(1);
  }

  let results;

  if (args.matrix) {
    results = await runMatrix({
      target: args.target,
      usersMatrix: args.usersMatrix,
      speedMatrix: args.speedMatrix,
      duration: args.duration,
      warmup: args.warmup,
      cooldown: args.cooldown,
      mode: args.mode,
      spawnDelay: args.spawnDelay,
      apiUrl: args.apiUrl,
      apiToken: args.apiToken,
    });
  } else {
    results = await runBenchmark({
      target: args.target,
      users: args.users,
      duration: args.duration,
      warmup: args.warmup,
      cooldown: args.cooldown,
      speed: args.speed,
      mode: args.mode,
      spawnDelay: args.spawnDelay,
      apiUrl: args.apiUrl,
      apiToken: args.apiToken,
    });
  }

  // Save to file
  if (args.output) {
    const json = JSON.stringify(results, null, 2);
    writeFileSync(args.output, json, 'utf8');
    console.log(`${c.green}✓ Results saved to: ${args.output}${c.reset}`);
  }

  // Upload to dashboard
  if (args.apiUrl && args.apiToken) {
    await uploadResults(results, args.apiUrl, args.apiToken);
  }
}

main().catch(err => {
  console.error(`${c.red}Fatal: ${err.message}${c.reset}`);
  process.exit(1);
});
