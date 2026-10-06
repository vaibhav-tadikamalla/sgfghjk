/**
 * routes/benchmark.ts
 *
 * Admin endpoints for the PeerGrid benchmark system.
 *
 * All endpoints require admin auth (identical to simulation.ts pattern).
 *
 * Routes:
 *   POST   /admin/benchmark/run             — start a benchmark run
 *   POST   /admin/benchmark/cancel          — cancel the running benchmark
 *   GET    /admin/benchmark/status          — live status
 *   GET    /admin/benchmark/targets         — allowed target URLs (SSRF allowlist)
 *   GET    /admin/benchmark/runs            — list persisted runs (paginated)
 *   GET    /admin/benchmark/runs/:id        — single run detail
 *   GET    /admin/benchmark/runs/:id/export.json  — JSON export
 *   GET    /admin/benchmark/runs/:id/export.csv   — CSV export
 *   DELETE /admin/benchmark/runs/:id        — delete a run record
 *   POST   /admin/benchmark/matrix          — run academic matrix (sequential)
 *   POST   /admin/benchmark/mint-token      — mint JWT for external CLI runner
 *   POST   /admin/benchmark/external-result — receive results from external CLI
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { verifyAccessToken } from '../auth/jwt';
import {
  getBenchmarkEngine,
  validateBenchmarkConfig,
  getAllowedBenchmarkTargets,
} from '../benchmark/BenchmarkEngine';
import { query } from '../db/pool';

// ── Auth (identical pattern to simulation.ts) ─────────────────────────────────

function getAdminSecretOrThrow(): string {
  const secret = process.env['ADMIN_SECRET']?.trim() ?? '';
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';
  if (nodeEnv === 'production' && secret.length === 0) {
    throw new Error('ADMIN_SECRET is required in production for benchmark routes.');
  }
  return secret;
}

const ADMIN_ALLOWED_EMAIL = 'tadikamallavaibhav@gmail.com';

async function requireAdminToken(request: FastifyRequest, reply: FastifyReply, secret: string): Promise<boolean> {
  if (secret.length === 0) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Admin secret required' });
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
      if (token.email?.toLowerCase() === ADMIN_ALLOWED_EMAIL) return true;
    } catch { /* fall through */ }
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

export async function registerBenchmarkRoutes(app: FastifyInstance): Promise<void> {
  const adminSecret = getAdminSecretOrThrow();

  /**
   * POST /admin/benchmark/run
   *
   * Start a benchmark run. Returns immediately with runId.
   * The benchmark executes asynchronously.
   *
   * Body: BenchmarkConfig
   */
  app.post('/admin/benchmark/run', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const body = (request.body as Record<string, unknown>) ?? {};
    const config = {
      userCount: Number(body['userCount'] ?? 5),
      durationSeconds: Number(body['durationSeconds'] ?? 60),
      warmupSeconds: body['warmupSeconds'] != null ? Number(body['warmupSeconds']) : undefined,
      cooldownSeconds: body['cooldownSeconds'] != null ? Number(body['cooldownSeconds']) : undefined,
      typingSpeed: body['typingSpeed'] != null ? Number(body['typingSpeed']) : undefined,
      reconnectProbability: body['reconnectProbability'] != null ? Number(body['reconnectProbability']) : 0,
      spawnDelayMs: body['spawnDelayMs'] != null ? Number(body['spawnDelayMs']) : undefined,
      targetUrl: String(body['targetUrl'] ?? getAllowedBenchmarkTargets()[0] ?? `ws://localhost:${process.env['PORT'] ?? '3001'}/ws`),
      targetRoom: body['targetRoom'] != null ? String(body['targetRoom']) : undefined,
      seed: body['seed'] != null ? Number(body['seed']) : undefined,
      collectResourceMetrics: body['collectResourceMetrics'] != null ? Boolean(body['collectResourceMetrics']) : true,
      benchmarkMode: (['latency', 'load'].includes(String(body['benchmarkMode'])) ? String(body['benchmarkMode']) : 'latency') as 'latency' | 'load',
    };

    const errors = validateBenchmarkConfig(config);
    if (errors.length > 0) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Invalid benchmark config',
        details: errors,
      });
    }

    const engine = getBenchmarkEngine();
    if (engine.isRunning) {
      return reply.code(409).send({
        error: 'Conflict',
        message: 'A benchmark is already running. Cancel it first.',
      });
    }

    try {
      const runId = await engine.start(config);
      return reply.send({
        status: 'started',
        runId,
        message: `Benchmark started with ${config.userCount} users for ${config.durationSeconds}s`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ error: 'Internal Server Error', message });
    }
  });

  /**
   * POST /admin/benchmark/cancel
   * Cancel the running benchmark.
   */
  app.post('/admin/benchmark/cancel', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;
    const engine = getBenchmarkEngine();
    if (!engine.isRunning) {
      return reply.code(409).send({ error: 'Conflict', message: 'No benchmark is currently running' });
    }
    engine.cancel();
    return reply.send({ status: 'cancelled', message: 'Benchmark cancellation requested' });
  });

  /**
   * GET /admin/benchmark/status
   * Live status of the current (or last) benchmark run.
   */
  app.get('/admin/benchmark/status', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;
    const engine = getBenchmarkEngine();
    return reply.send(engine.status);
  });

  /**
   * GET /admin/benchmark/targets
   * Returns the list of allowed benchmark target WebSocket URLs.
   * Configured via BENCHMARK_ALLOWED_TARGETS env var (comma-separated).
   * The UI uses this list to build a dropdown — no arbitrary URL entry.
   */
  app.get('/admin/benchmark/targets', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;
    return reply.send({ targets: getAllowedBenchmarkTargets() });
  });

  /**
   * GET /admin/benchmark/runs
   * List persisted benchmark runs, newest first.
   * Query params: limit (default 20, max 100), offset (default 0)
   */
  app.get('/admin/benchmark/runs', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const qs = (request.query as Record<string, string>) ?? {};
    const limit = Math.min(100, Math.max(1, Number(qs['limit'] ?? 20)));
    const offset = Math.max(0, Number(qs['offset'] ?? 0));

    const result = await query<{
      id: string;
      created_at: string;
      started_at: string | null;
      completed_at: string | null;
      status: string;
      target_url: string;
      environment: Record<string, unknown>;
      config: Record<string, unknown>;
      results: Record<string, unknown> | null;
      error_message: string | null;
    }>(
      `SELECT id, created_at, started_at, completed_at, status,
              target_url, environment, config, results, error_message
       FROM benchmark_runs
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    const countResult = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM benchmark_runs',
    );

    return reply.send({
      total: Number(countResult.rows[0]?.count ?? 0),
      limit,
      offset,
      runs: result.rows,
    });
  });

  /**
   * GET /admin/benchmark/runs/:id
   * Single run detail (full results).
   */
  app.get('/admin/benchmark/runs/:id', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const { id } = request.params as { id: string };
    const result = await query(
      `SELECT * FROM benchmark_runs WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Not Found', message: `Run ${id} not found` });
    }

    return reply.send(result.rows[0]);
  });

  /**
   * GET /admin/benchmark/runs/:id/export.json
   * Full JSON export of a run.
   */
  app.get('/admin/benchmark/runs/:id/export.json', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const { id } = request.params as { id: string };
    const result = await query(`SELECT * FROM benchmark_runs WHERE id = $1`, [id]);

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Not Found', message: `Run ${id} not found` });
    }

    const run = result.rows[0];
    reply.header('Content-Disposition', `attachment; filename="benchmark-${id.slice(0, 8)}.json"`);
    reply.header('Content-Type', 'application/json');
    return reply.send(JSON.stringify(run, null, 2));
  });

  /**
   * GET /admin/benchmark/runs/:id/export.csv
   * CSV export of a run's key metrics.
   */
  app.get('/admin/benchmark/runs/:id/export.csv', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const { id } = request.params as { id: string };
    const result = await query(`SELECT * FROM benchmark_runs WHERE id = $1`, [id]);

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Not Found', message: `Run ${id} not found` });
    }

    const run = result.rows[0];
    const cfg = (run.config ?? {}) as Record<string, unknown>;
    const res = (run.results ?? {}) as Record<string, unknown>;
    const lat = (res['latency'] ?? {}) as Record<string, unknown>;

    const rows = [
      ['run_id', 'status', 'created_at', 'target_url', 'user_count', 'duration_s',
       'warmup_s', 'cooldown_s', 'typing_speed',
       'samples', 'min_ms', 'mean_ms', 'p50_ms', 'p90_ms', 'p95_ms', 'p99_ms', 'stddev_ms',
       'ops_attempted', 'ops_propagated', 'ops_timed_out',
       'success_rate', 'propagated_ops_per_sec',
       'convergence_achieved', 'convergence_time_ms',
       'connection_attempts', 'connection_failures',
       'process_mem_start_bytes', 'process_mem_peak_bytes'].join(','),
      [
        run.id, run.status, run.created_at, run.target_url,
        cfg['userCount'] ?? '', cfg['durationSeconds'] ?? '',
        cfg['warmupSeconds'] ?? '', cfg['cooldownSeconds'] ?? '',
        cfg['typingSpeed'] ?? '',
        lat['sampleCount'] ?? '', lat['minMs'] ?? '', lat['meanMs'] ?? '',
        lat['p50Ms'] ?? '', lat['p90Ms'] ?? '', lat['p95Ms'] ?? '', lat['p99Ms'] ?? '', lat['stddevMs'] ?? '',
        res['opsAttempted'] ?? '', res['opsPropagated'] ?? '', res['opsTimedOut'] ?? '',
        res['successRate'] ?? '', res['propagatedOpsPerSec'] ?? '',
        res['convergenceAchieved'] ?? '', res['convergenceTimeMs'] ?? '',
        res['connectionAttempts'] ?? '', res['connectionFailures'] ?? '',
        res['processMemoryAtStartBytes'] ?? '', res['processMemoryPeakBytes'] ?? '',
      ].join(','),
    ].join('\n');

    reply.header('Content-Disposition', `attachment; filename="benchmark-${id.slice(0, 8)}.csv"`);
    reply.header('Content-Type', 'text/csv');
    return reply.send(rows);
  });

  /**
   * DELETE /admin/benchmark/runs/:id
   * Delete a benchmark run record from the database.
   */
  app.delete('/admin/benchmark/runs/:id', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const { id } = request.params as { id: string };
    const result = await query(
      'DELETE FROM benchmark_runs WHERE id = $1 RETURNING id',
      [id],
    );

    if (result.rowCount === 0) {
      return reply.code(404).send({ error: 'Not Found', message: `Run ${id} not found` });
    }

    return reply.send({ status: 'deleted', id });
  });

  /**
   * POST /admin/benchmark/matrix
   *
   * Run an academic benchmark matrix: a grid of (userCount × typingSpeed)
   * combinations, each run sequentially.
   *
   * Body:
   * {
   *   userMatrix?: number[],        -- default [1, 5, 10, 20, 30, 40, 50]
   *   typingSpeedMatrix?: number[], -- default [2]
   *   durationSeconds?: number,     -- default 60
   *   warmupSeconds?: number,
   *   cooldownSeconds?: number,
   *   targetUrl?: string            -- must be in allowlist
   * }
   *
   * Returns a list of run IDs in order. Runs execute asynchronously in sequence.
   */
  app.post('/admin/benchmark/matrix', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const engine = getBenchmarkEngine();
    if (engine.isRunning) {
      return reply.code(409).send({ error: 'Conflict', message: 'A benchmark is already running' });
    }

    const body = (request.body as Record<string, unknown>) ?? {};
    const userMatrix: number[] = Array.isArray(body['userMatrix'])
      ? (body['userMatrix'] as number[]).map(Number).filter(n => n >= 1 && n <= 200)
      : [1, 5, 10, 20, 30, 40, 50];

    const typingSpeedMatrix: number[] = Array.isArray(body['typingSpeedMatrix'])
      ? (body['typingSpeedMatrix'] as number[]).map(Number).filter(n => n > 0 && n <= 50)
      : [2];

    const durationSeconds = Math.max(10, Math.min(600, Number(body['durationSeconds'] ?? 60)));
    const warmupSeconds = body['warmupSeconds'] != null ? Number(body['warmupSeconds']) : 15;
    const cooldownSeconds = body['cooldownSeconds'] != null ? Number(body['cooldownSeconds']) : 10;
    const allowed = getAllowedBenchmarkTargets();
    const targetUrl = String(body['targetUrl'] ?? allowed[0] ?? `ws://localhost:${process.env['PORT'] ?? '3001'}/ws`);

    if (!allowed.includes(targetUrl)) {
      return reply.code(400).send({ error: 'Bad Request', message: `targetUrl must be one of: ${allowed.join(', ')}` });
    }

    const totalCells = userMatrix.length * typingSpeedMatrix.length;
    if (totalCells > 50) {
      return reply.code(400).send({ error: 'Bad Request', message: `Matrix too large: ${totalCells} cells. Max 50.` });
    }

    // Build matrix cells
    const cells: Array<{ userCount: number; typingSpeed: number }> = [];
    for (const userCount of userMatrix) {
      for (const typingSpeed of typingSpeedMatrix) {
        cells.push({ userCount, typingSpeed });
      }
    }

    // Insert placeholder run IDs for all matrix cells upfront
    const runIds: string[] = [];
    for (const cell of cells) {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO benchmark_runs (status, target_url, environment, config)
         VALUES ('queued', $1, '{}', $2)
         RETURNING id`,
        [targetUrl, JSON.stringify({ ...cell, durationSeconds, warmupSeconds, cooldownSeconds, targetUrl })],
      );
      runIds.push(rows[0]!.id);
    }

    // Execute matrix sequentially in background
    void runMatrixSequential(cells, runIds, { durationSeconds, warmupSeconds, cooldownSeconds, targetUrl });

    return reply.send({
      status: 'queued',
      totalRuns: cells.length,
      runIds,
      message: `Matrix of ${cells.length} benchmark runs queued. They will execute sequentially.`,
    });
  });

  /**
   * POST /admin/benchmark/mint-token
   *
   * Mints a JWT for a simulated benchmark editor, for use by the external CLI
   * runner on the admin's laptop. The userId starts with 'sim-user-' and the
   * fileId starts with 'sim-' so PermissionGateway's bypass triggers and no
   * DB user record is required.
   *
   * Body: { editorIndex: number, runId?: string, fileId?: string }
   * Returns: { token: string, fileId: string, editorId: string, userId: string }
   */
  app.post('/admin/benchmark/mint-token', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const body = (request.body as Record<string, unknown>) ?? {};
    const editorIndex = Number(body['editorIndex'] ?? 1);
    const runId = body['runId'] ? String(body['runId']) : randomUUID();
    const fileId = body['fileId'] ? String(body['fileId']) : `sim-ext-bench-${runId.slice(0, 8)}`;

    // userId MUST start with 'sim-user-' for PermissionGateway bypass (no DB lookup)
    const userId = `sim-user-ext-${runId.slice(0, 8)}-${editorIndex}`;
    const editorId = `ext-editor-${editorIndex}-${runId.slice(0, 6)}`;

    try {
      const { generateAccessToken } = await import('../auth/jwt');
      const { token } = await generateAccessToken({
        id: userId,
        email: `${editorId}@ext-bench.peergrid.local`,
        displayName: `ExtBench ${editorIndex}`,
      });
      return reply.send({ token, fileId, editorId, userId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ error: 'Internal Server Error', message: msg });
    }
  });

  /**
   * POST /admin/benchmark/external-result
   *
   * Receives results from the external CLI benchmark runner and persists
   * them to the benchmark_runs table so they appear in the Admin Dashboard.
   *
   * Body: { results: ExternalResult[] }
   * Returns: { status: 'ok', inserted: number, runIds: string[] }
   */
  app.post('/admin/benchmark/external-result', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const body = (request.body as Record<string, unknown>) ?? {};
    const rawResults = Array.isArray(body['results']) ? body['results'] : [body];

    const inserted: string[] = [];
    for (const r of rawResults) {
      if (typeof r !== 'object' || !r) continue;
      const result = r as Record<string, unknown>;
      const runId = result['runId'] ? String(result['runId']) : randomUUID();
      const targetUrl = String(result['target'] ?? 'external');
      const label = String(result['label'] ?? 'External benchmark');
      const env = JSON.stringify({ source: 'external-cli', label, mode: result['mode'] ?? 'latency' });
      const cfg = JSON.stringify(result['config'] ?? {});

      try {
        await query(
          `INSERT INTO benchmark_runs (id, status, target_url, environment, config, results, started_at, completed_at)
           VALUES ($1, 'completed', $2, $3, $4, $5, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE
             SET status = 'completed', results = EXCLUDED.results, completed_at = NOW()`,
          [runId, targetUrl, env, cfg, JSON.stringify(result)],
        );
        inserted.push(runId);
      } catch (err) {
        app.log?.error({ err, runId }, 'Failed to insert external benchmark result');
      }
    }

    return reply.send({ status: 'ok', inserted: inserted.length, runIds: inserted });
  });
}

// ── Matrix runner (background, sequential) ────────────────────────────────────

async function runMatrixSequential(
  cells: Array<{ userCount: number; typingSpeed: number }>,
  runIds: string[],
  shared: { durationSeconds: number; warmupSeconds: number; cooldownSeconds: number; targetUrl: string },
): Promise<void> {
  const engine = getBenchmarkEngine();

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    const runId = runIds[i]!;

    // If a prior run left the engine in a bad state, wait a bit
    if (engine.isRunning) {
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }

    try {
      await engine.start({
        userCount: cell.userCount,
        typingSpeed: cell.typingSpeed,
        durationSeconds: shared.durationSeconds,
        warmupSeconds: shared.warmupSeconds,
        cooldownSeconds: shared.cooldownSeconds,
        targetUrl: shared.targetUrl,
        targetRoom: `sim-bench-matrix-${runId.slice(0, 8)}`,
      });

      // Wait for this run to complete before starting next
      await waitForEngineIdle(engine, 300_000); // 5-minute max
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await query(
        `UPDATE benchmark_runs SET status = 'failed', error_message = $2, completed_at = NOW() WHERE id = $1`,
        [runId, msg],
      ).catch(() => {/* ignore */});
    }

    // Pause between runs
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
}

async function waitForEngineIdle(engine: ReturnType<typeof getBenchmarkEngine>, maxMs: number): Promise<void> {
  const start = Date.now();
  while (engine.isRunning && Date.now() - start < maxMs) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}
