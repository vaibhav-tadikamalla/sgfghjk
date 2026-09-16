/**
 * routes/simulation.ts
 *
 * Admin endpoints for controlling the editor swarm simulator.
 *
 *   POST /admin/simulation/start     — start a simulation with config
 *   POST /admin/simulation/stop      — stop the running simulation
 *   GET  /admin/simulation/status    — current simulation snapshot
 *
 * Uses the same ADMIN_SECRET auth as admin-dashboard.ts.
 * All endpoints are lightweight and non-blocking.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { getClusterSimulator, getSwarmSimulator, type FailureType, type ScenarioId } from '../simulator';
import { verifyAccessToken } from '../auth/jwt';

// ── Admin secret ──────────────────────────────────────────────────────────────

function getAdminSecretOrThrow(): string {
  const secret = process.env['ADMIN_SECRET']?.trim() ?? '';
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';
  if (nodeEnv === 'production' && secret.length === 0) {
    throw new Error('ADMIN_SECRET is required in production for simulation routes.');
  }
  return secret;
}

const ADMIN_ALLOWED_EMAIL = 'tadikamallavaibhav@gmail.com';

async function requireAdminToken(request: FastifyRequest, reply: FastifyReply, secret: string): Promise<boolean> {
  if (secret.length === 0) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Admin secret is required' });
    return false;
  }

  const authHeader = request.headers['authorization'];
  const bearerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : null;
  const xAdminToken = typeof request.headers['x-admin-token'] === 'string'
    ? request.headers['x-admin-token'].trim()
    : null;

  if (bearerToken) {
    const providedBuffer = Buffer.from(bearerToken);
    const secretBuffer = Buffer.from(secret);
    if (providedBuffer.length === secretBuffer.length && timingSafeEqual(providedBuffer, secretBuffer)) {
      return true;
    }

    try {
      const token = await verifyAccessToken(bearerToken);
      if (token.email?.toLowerCase() === ADMIN_ALLOWED_EMAIL) {
        return true;
      }
    } catch {
      // fall through to explicit forbidden response
    }
  }

  if (xAdminToken) {
    const providedBuffer = Buffer.from(xAdminToken);
    const secretBuffer = Buffer.from(secret);
    if (providedBuffer.length === secretBuffer.length && timingSafeEqual(providedBuffer, secretBuffer)) {
      return true;
    }
  }

  reply.code(403).send({ error: 'Forbidden', message: 'Invalid admin token' });
  return false;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerSimulationRoutes(app: FastifyInstance): Promise<void> {
  const adminSecret = getAdminSecretOrThrow();

  /**
   * POST /admin/simulation/start
   *
   * Start a swarm simulation.
   *
   * Body:
   * {
   *   editorCount: number (1–1000),
   *   targetRoom: string (file ID — must start with "sim-"),
   *   typingSpeed?: number (chars/sec, default 5),
   *   reconnectProbability?: number (0–1, default 0.02),
   *   spawnDelayMs?: number (ms between spawns, default 50)
   * }
   */
  app.post('/admin/simulation/start', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const body = request.body as Record<string, unknown> | null;
    if (!body) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Request body required' });
    }

    const editorCount = Number(body['editorCount']);
    const targetRoom = String(body['targetRoom'] ?? '');

    // Validation
    if (!Number.isFinite(editorCount) || editorCount < 1 || editorCount > 1000) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'editorCount must be between 1 and 1000',
      });
    }

    if (!targetRoom) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'targetRoom is required',
      });
    }

    // Enforce sim- prefix for safety
    const safeRoom = targetRoom.startsWith('sim-') ? targetRoom : `sim-${targetRoom}`;

    const simulator = getSwarmSimulator();

    try {
      // Start is async (it spawns editors with staggered delays)
      // Don't await — return immediately and let it run
      void simulator.start({
        editorCount: Math.floor(editorCount),
        targetRoom: safeRoom,
        typingSpeed: body['typingSpeed'] != null ? Number(body['typingSpeed']) : undefined,
        reconnectProbability: body['reconnectProbability'] != null ? Number(body['reconnectProbability']) : undefined,
        spawnDelayMs: body['spawnDelayMs'] != null ? Number(body['spawnDelayMs']) : undefined,
      });

      return reply.send({
        status: 'starting',
        message: `Spawning ${Math.floor(editorCount)} simulated editors in room "${safeRoom}"`,
        targetRoom: safeRoom,
        editorCount: Math.floor(editorCount),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(409).send({
        error: 'Conflict',
        message,
      });
    }
  });

  /**
   * POST /admin/simulation/stop
   *
   * Stop the running simulation. Safe to call when no simulation is running.
   */
  app.post('/admin/simulation/stop', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const simulator = getSwarmSimulator();
    await simulator.stop();

    return reply.send({
      status: 'stopped',
      message: 'Simulation stopped',
    });
  });

  /**
   * GET /admin/simulation/status
   *
   * Get current simulation status and metrics.
   */
  app.get('/admin/simulation/status', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const simulator = getSwarmSimulator();
    const snapshot = simulator.getSnapshot();

    return reply.send(snapshot);
  });

  /**
   * POST /admin/simulation/cluster/start
   *
   * Start multi-node simulation.
   */
  app.post('/admin/simulation/cluster/start', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const body = request.body as Record<string, unknown> | null;
    if (!body) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Request body required' });
    }

    const editorCount = Number(body['editorCount']);
    const targetRoomRaw = String(body['targetRoom'] ?? 'sim-cluster');
    const scenario = String(body['scenario'] ?? 'balanced') as ScenarioId;
    const nodesInput = Array.isArray(body['nodes']) ? body['nodes'] : [];

    if (!Number.isFinite(editorCount) || editorCount < 1 || editorCount > 1000) {
      return reply.code(400).send({ error: 'Bad Request', message: 'editorCount must be between 1 and 1000' });
    }

    if (nodesInput.length < 1) {
      return reply.code(400).send({ error: 'Bad Request', message: 'At least one node is required' });
    }

    const validScenarios: ScenarioId[] = ['balanced', 'hotspot', 'node-crash', 'mirror-resync', 'reconnect-storm'];
    if (!validScenarios.includes(scenario)) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: `scenario must be one of: ${validScenarios.join(', ')}`,
      });
    }

    const nodes = nodesInput
      .map((node, index) => {
        const raw = (node ?? {}) as Record<string, unknown>;
        const nodeId = String(raw['nodeId'] ?? `node-${index + 1}`);
        const wsUrl = String(raw['wsUrl'] ?? '');
        const label = String(raw['label'] ?? nodeId);
        return { nodeId, wsUrl, label };
      })
      .filter(n => Boolean(n.wsUrl));

    if (nodes.length < 1) {
      return reply.code(400).send({ error: 'Bad Request', message: 'nodes[].wsUrl is required' });
    }

    const targetRoom = targetRoomRaw.startsWith('sim-') ? targetRoomRaw : `sim-${targetRoomRaw}`;
    const simulator = getClusterSimulator();

    try {
      await simulator.start({
        editorCount: Math.floor(editorCount),
        targetRoom,
        scenario,
        nodes,
        typingSpeed: body['typingSpeed'] != null ? Number(body['typingSpeed']) : undefined,
        reconnectProbability: body['reconnectProbability'] != null ? Number(body['reconnectProbability']) : undefined,
        spawnDelayMs: body['spawnDelayMs'] != null ? Number(body['spawnDelayMs']) : undefined,
      });

      return reply.send({
        status: 'running',
        mode: 'cluster',
        scenario,
        editorCount: Math.floor(editorCount),
        nodes: nodes.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(409).send({ error: 'Conflict', message });
    }
  });

  app.post('/admin/simulation/cluster/stop', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const simulator = getClusterSimulator();
    await simulator.stop();

    return reply.send({ status: 'stopped', mode: 'cluster' });
  });

  app.get('/admin/simulation/cluster/status', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const simulator = getClusterSimulator();
    return reply.send(simulator.getSnapshot());
  });

  app.post('/admin/simulation/cluster/failure/inject', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const body = request.body as Record<string, unknown> | null;
    if (!body) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Request body required' });
    }

    const type = String(body['type'] ?? '') as FailureType;
    const nodeId = String(body['nodeId'] ?? '');
    const durationMs = body['durationMs'] != null ? Number(body['durationMs']) : undefined;

    const validTypes: FailureType[] = ['node-shutdown', 'redis-delay', 'network-partition', 'mirror-eviction'];
    if (!validTypes.includes(type)) {
      return reply.code(400).send({ error: 'Bad Request', message: `type must be one of: ${validTypes.join(', ')}` });
    }
    if (!nodeId) {
      return reply.code(400).send({ error: 'Bad Request', message: 'nodeId is required' });
    }

    const simulator = getClusterSimulator();
    const result = simulator.injectFailure(type, nodeId, durationMs);
    if (!result.success) {
      return reply.code(400).send({ error: 'Bad Request', message: result.message });
    }

    return reply.send({ status: 'ok', ...result });
  });

  app.post('/admin/simulation/cluster/failure/resolve', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const body = request.body as Record<string, unknown> | null;
    if (!body) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Request body required' });
    }

    const eventId = String(body['eventId'] ?? '');
    if (!eventId) {
      return reply.code(400).send({ error: 'Bad Request', message: 'eventId is required' });
    }

    const simulator = getClusterSimulator();
    const result = simulator.resolveFailure(eventId);

    if (!result.success) {
      return reply.code(400).send({ error: 'Bad Request', message: result.message });
    }

    return reply.send({ status: 'ok', ...result });
  });

  // ── Chaos Engineering endpoints ───────────────────────────────────────

  /**
   * POST /admin/simulation/chaos/start
   *
   * Start automated chaos engineering. Cluster simulation must be running.
   *
   * Body (all optional):
   * {
   *   intervalSeconds?: number,
   *   maxConcurrentFailures?: number,
   *   recoverySeconds?: number
   * }
   */
  app.post('/admin/simulation/chaos/start', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const simulator = getClusterSimulator();
    if (simulator.state !== 'running') {
      return reply.code(409).send({
        error: 'Conflict',
        message: 'Cluster simulation must be running to start chaos',
      });
    }

    const body = (request.body as Record<string, unknown>) ?? {};
    const config: Record<string, number> = {};
    if (body['intervalSeconds'] != null) config['intervalSeconds'] = Math.max(5, Number(body['intervalSeconds']) || 60);
    if (body['maxConcurrentFailures'] != null) config['maxConcurrentFailures'] = Math.max(1, Math.min(10, Number(body['maxConcurrentFailures']) || 2));
    if (body['recoverySeconds'] != null) config['recoverySeconds'] = Math.max(10, Number(body['recoverySeconds']) || 120);

    try {
      simulator.startChaos(Object.keys(config).length > 0 ? config : undefined);
      return reply.send({ status: 'running', message: 'Chaos engine started' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(409).send({ error: 'Conflict', message });
    }
  });

  /**
   * POST /admin/simulation/chaos/stop
   */
  app.post('/admin/simulation/chaos/stop', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const simulator = getClusterSimulator();
    simulator.stopChaos();
    return reply.send({ status: 'stopped', message: 'Chaos engine stopped' });
  });

  /**
   * GET /admin/simulation/chaos/status
   *
   * Returns ChaosSnapshot. Returns a default idle snapshot when chaos is inactive.
   */
  app.get('/admin/simulation/chaos/status', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const simulator = getClusterSimulator();
    const snapshot = simulator.getChaosSnapshot();

    if (!snapshot) {
      return reply.send({
        config: { enabled: false, intervalSeconds: 60, maxConcurrentFailures: 2, recoverySeconds: 120 },
        state: 'idle',
        startedAt: null,
        elapsedMs: 0,
        totalInjections: 0,
        totalRecoveries: 0,
        activeFailures: [],
        timeline: [],
        metrics: {
          meanTimeToRecoveryMs: 0,
          availabilityPercent: 100,
          resilienceScore: 100,
          recoveryRate: 100,
          failuresByType: { 'node-crash': 0, 'redis-delay': 0, 'network-partition': 0, 'mirror-eviction': 0, 'connection-storm': 0 },
          recoveredByType: { 'node-crash': 0, 'redis-delay': 0, 'network-partition': 0, 'mirror-eviction': 0, 'connection-storm': 0 },
          nodeFailureCounts: [],
        },
      });
    }

    return reply.send(snapshot);
  });

  /**
   * POST /admin/simulation/chaos/configure
   *
   * Update chaos config while chaos is running.
   *
   * Body:
   * {
   *   enabled?: boolean,
   *   intervalSeconds?: number,
   *   maxConcurrentFailures?: number,
   *   recoverySeconds?: number
   * }
   */
  app.post('/admin/simulation/chaos/configure', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const simulator = getClusterSimulator();
    if (simulator.state !== 'running') {
      return reply.code(409).send({
        error: 'Conflict',
        message: 'Cluster simulation must be running to configure chaos',
      });
    }

    const body = (request.body as Record<string, unknown>) ?? {};
    const config: Record<string, unknown> = {};
    if (body['enabled'] != null) config['enabled'] = Boolean(body['enabled']);
    if (body['intervalSeconds'] != null) config['intervalSeconds'] = Math.max(5, Number(body['intervalSeconds']) || 60);
    if (body['maxConcurrentFailures'] != null) config['maxConcurrentFailures'] = Math.max(1, Math.min(10, Number(body['maxConcurrentFailures']) || 2));
    if (body['recoverySeconds'] != null) config['recoverySeconds'] = Math.max(10, Number(body['recoverySeconds']) || 120);

    try {
      simulator.configureChaos(config);
      return reply.send({ status: 'ok', message: 'Chaos config updated' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(409).send({ error: 'Conflict', message });
    }
  });

  // ── Deterministic Replay ──────────────────────────────────────────────────

  /** POST /admin/simulation/replay/record/start — start recording */
  app.post('/admin/simulation/replay/record/start', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;
    const simulator = getClusterSimulator();
    if (simulator.state !== 'running') {
      return reply.code(409).send({ error: 'Conflict', message: 'Cluster simulation must be running to record' });
    }
    try {
      simulator.startRecording();
      return reply.send({ status: 'ok', message: 'Recording started' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(409).send({ error: 'Conflict', message });
    }
  });

  /** POST /admin/simulation/replay/record/stop — stop recording, return trace */
  app.post('/admin/simulation/replay/record/stop', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;
    const simulator = getClusterSimulator();
    try {
      const trace = simulator.stopRecording();
      return reply.send({ status: 'ok', trace });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(409).send({ error: 'Conflict', message });
    }
  });

  /** GET /admin/simulation/replay/traces — list stored traces */
  app.get('/admin/simulation/replay/traces', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;
    const simulator = getClusterSimulator();
    const traces = simulator.getTraces();
    return reply.send({ traces });
  });

  /** GET /admin/simulation/replay/traces/:id — get specific trace (export) */
  app.get('/admin/simulation/replay/traces/:id', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;
    const simulator = getClusterSimulator();
    const { id } = request.params as { id: string };
    const trace = simulator.getTrace(id);
    if (!trace) {
      return reply.code(404).send({ error: 'Not Found', message: `Trace ${id} not found` });
    }
    return reply.send({ trace });
  });

  /** POST /admin/simulation/replay/import — import a trace JSON */
  app.post('/admin/simulation/replay/import', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;
    const simulator = getClusterSimulator();
    const body = request.body as Record<string, unknown>;
    if (!body || !body['trace']) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Missing trace in body' });
    }
    try {
      simulator.importTrace(body['trace'] as never);
      return reply.send({ status: 'ok', message: 'Trace imported' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(400).send({ error: 'Bad Request', message });
    }
  });

  /** POST /admin/simulation/replay/start — start replay */
  app.post('/admin/simulation/replay/start', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;
    const simulator = getClusterSimulator();
    if (simulator.state !== 'running') {
      return reply.code(409).send({ error: 'Conflict', message: 'Cluster simulation must be running to replay' });
    }
    const body = (request.body as Record<string, unknown>) ?? {};
    const traceId = body['traceId'] as string | undefined;
    const mode = (body['mode'] as string) || 'continuous';
    if (!traceId) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Missing traceId' });
    }
    try {
      simulator.startReplay(traceId, mode as 'continuous' | 'step');
      return reply.send({ status: 'ok', message: `Replay started in ${mode} mode` });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(409).send({ error: 'Conflict', message });
    }
  });

  /** POST /admin/simulation/replay/stop — stop replay */
  app.post('/admin/simulation/replay/stop', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;
    const simulator = getClusterSimulator();
    try {
      simulator.stopReplay();
      return reply.send({ status: 'ok', message: 'Replay stopped' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(409).send({ error: 'Conflict', message });
    }
  });

  /** POST /admin/simulation/replay/pause — pause continuous replay */
  app.post('/admin/simulation/replay/pause', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;
    const simulator = getClusterSimulator();
    try {
      simulator.pauseReplay();
      return reply.send({ status: 'ok', message: 'Replay paused' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(409).send({ error: 'Conflict', message });
    }
  });

  /** POST /admin/simulation/replay/resume — resume paused replay */
  app.post('/admin/simulation/replay/resume', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;
    const simulator = getClusterSimulator();
    try {
      simulator.resumeReplay();
      return reply.send({ status: 'ok', message: 'Replay resumed' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(409).send({ error: 'Conflict', message });
    }
  });

  /** POST /admin/simulation/replay/step — step forward in step mode */
  app.post('/admin/simulation/replay/step', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;
    const simulator = getClusterSimulator();
    try {
      const event = simulator.stepForward();
      return reply.send({ status: 'ok', event });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(409).send({ error: 'Conflict', message });
    }
  });

  /** GET /admin/simulation/replay/status — replay snapshot */
  app.get('/admin/simulation/replay/status', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;
    const simulator = getClusterSimulator();
    const snapshot = simulator.getReplaySnapshot();
    return reply.send(snapshot);
  });
}
