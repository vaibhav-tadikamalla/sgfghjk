/**
 * versionMetrics.ts
 *
 * Prometheus metrics for the Document Version History feature.
 * Registered on the shared PeerGrid registry.
 */

import { Counter, Histogram } from 'prom-client';
import { register } from './metrics';

// ── Version capture counter ──────────────────────────────────────────────────

export const versionCapturesTotal = new Counter({
  name: 'peergrid_version_captures_total',
  help: 'Total number of document versions captured',
  labelNames: ['source'] as const,   // 'auto' | 'manual' | 'restore'
  registers: [register],
});

// ── Version snapshot bytes ───────────────────────────────────────────────────

export const versionCaptureBytes = new Histogram({
  name: 'peergrid_version_capture_bytes',
  help: 'Size of version snapshots in bytes',
  buckets: [1024, 4096, 16384, 65536, 262144, 1048576, 4194304],
  registers: [register],
});

// ── Version restore counter ──────────────────────────────────────────────────

export const versionRestoreTotal = new Counter({
  name: 'peergrid_version_restore_total',
  help: 'Total number of version restores performed',
  registers: [register],
});

// ── Version prune counter ────────────────────────────────────────────────────

export const versionPruneTotal = new Counter({
  name: 'peergrid_version_prune_total',
  help: 'Total number of versions pruned by retention policy',
  registers: [register],
});

// ── Diff computation duration ────────────────────────────────────────────────

export const versionDiffDuration = new Histogram({
  name: 'peergrid_version_diff_duration_ms',
  help: 'Time to compute a diff between two versions (ms)',
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  registers: [register],
});

// ── Auto-capture skip counter (dedup / insufficient change) ──────────────────

export const versionAutoSkipTotal = new Counter({
  name: 'peergrid_version_auto_skip_total',
  help: 'Auto-capture attempts skipped (dedup or insufficient change)',
  labelNames: ['reason'] as const,   // 'duplicate' | 'too_soon' | 'too_small'
  registers: [register],
});
