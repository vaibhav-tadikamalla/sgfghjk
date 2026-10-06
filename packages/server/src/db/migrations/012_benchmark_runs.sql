-- ================================================================
-- 012 — BENCHMARK RUNS
-- Stores metadata and aggregate results for each benchmark run.
-- Per-operation data is NOT stored by default (aggregate only).
-- ================================================================

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL    DEFAULT NOW(),
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- Lifecycle: queued | running | completed | failed | cancelled
  status       TEXT        NOT NULL    DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),

  -- Where the benchmark targeted
  target_url   TEXT        NOT NULL,

  -- Runtime environment captured at run start
  -- { roomStore: 'memory'|'redis', nodeEnv: string, redisEnabled: boolean, version?: string }
  environment  JSONB       NOT NULL    DEFAULT '{}',

  -- Full BenchmarkConfig that was used
  config       JSONB       NOT NULL    DEFAULT '{}',

  -- Aggregate results (null while running or queued)
  -- See BenchmarkResults type in BenchmarkEngine.ts for shape
  results      JSONB,

  -- Error details if status = 'failed'
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_benchmark_runs_status
  ON benchmark_runs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_benchmark_runs_created
  ON benchmark_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_benchmark_runs_target
  ON benchmark_runs (target_url, created_at DESC);
