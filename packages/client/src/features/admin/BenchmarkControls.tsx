/**
 * admin/BenchmarkControls.tsx
 *
 * Form for configuring and starting a benchmark run, plus Cancel button.
 * Also includes the "Academic Matrix" quick-start.
 */

import React, { useState } from 'react';
import { useStartBenchmark, useCancelBenchmark, useStartMatrix } from './benchmarkHooks';
import type { BenchmarkConfig } from './benchmarkApi';

interface Props {
  isRunning: boolean;
}

export function BenchmarkControls({ isRunning }: Props) {
  const start = useStartBenchmark();
  const cancel = useCancelBenchmark();
  const matrix = useStartMatrix();

  const defaultUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host.replace(/:\d+$/, '')}:${window.location.port || (window.location.protocol === 'https:' ? '443' : '80')}/ws`;

  const [cfg, setCfg] = useState<BenchmarkConfig>({
    userCount: 5,
    durationSeconds: 60,
    warmupSeconds: 15,
    cooldownSeconds: 10,
    typingSpeed: 2,
    reconnectProbability: 0,
    targetUrl: defaultUrl,
    collectResourceMetrics: true,
  });

  const [matrixMode, setMatrixMode] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function num(field: keyof BenchmarkConfig, value: string) {
    const n = parseFloat(value);
    if (!isNaN(n)) setCfg(prev => ({ ...prev, [field]: n }));
  }

  async function handleStart() {
    setError(null);
    setSuccess(null);
    try {
      const result = await start.mutateAsync(cfg);
      setSuccess(`Run started: ${result.runId.slice(0, 8)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleMatrix() {
    setError(null);
    setSuccess(null);
    try {
      const result = await matrix.mutateAsync({
        userMatrix: [1, 5, 10, 20, 30, 40, 50],
        typingSpeedMatrix: [2],
        durationSeconds: Math.max(30, cfg.durationSeconds),
        warmupSeconds: cfg.warmupSeconds,
        cooldownSeconds: cfg.cooldownSeconds,
        targetUrl: cfg.targetUrl,
      });
      setSuccess(`Matrix queued: ${result.totalRuns} runs`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCancel() {
    setError(null);
    try {
      await cancel.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="bg-zinc-800/60 border border-zinc-700 rounded-lg p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-200">Configure Run</h3>
        <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={matrixMode}
            onChange={e => setMatrixMode(e.target.checked)}
            className="rounded border-zinc-600"
          />
          Academic matrix (1–50 users)
        </label>
      </div>

      {/* Core fields */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {!matrixMode && (
          <Field label="Users" hint="1–200">
            <input
              type="number" min={1} max={200}
              value={cfg.userCount}
              onChange={e => num('userCount', e.target.value)}
              className={inputCls}
            />
          </Field>
        )}
        <Field label="Duration (s)" hint="10–600">
          <input
            type="number" min={10} max={600}
            value={cfg.durationSeconds}
            onChange={e => num('durationSeconds', e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Typing speed (chars/s)" hint="0.1–50">
          <input
            type="number" min={0.1} max={50} step={0.5}
            value={cfg.typingSpeed}
            onChange={e => num('typingSpeed', e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Target WebSocket URL" hint="ws:// or wss://" className="col-span-2 sm:col-span-3">
          <input
            type="text"
            value={cfg.targetUrl}
            onChange={e => setCfg(prev => ({ ...prev, targetUrl: e.target.value }))}
            className={inputCls}
            placeholder="ws://localhost:3001/ws"
          />
        </Field>
      </div>

      {/* Advanced fields */}
      <button
        type="button"
        onClick={() => setShowAdvanced(v => !v)}
        className="text-xs text-zinc-500 hover:text-zinc-300"
      >
        {showAdvanced ? '▾ Hide' : '▸ Show'} advanced settings
      </button>

      {showAdvanced && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
          <Field label="Warm-up (s)">
            <input type="number" min={0} max={300} value={cfg.warmupSeconds ?? 15}
              onChange={e => num('warmupSeconds', e.target.value)} className={inputCls} />
          </Field>
          <Field label="Cooldown (s)">
            <input type="number" min={0} max={120} value={cfg.cooldownSeconds ?? 10}
              onChange={e => num('cooldownSeconds', e.target.value)} className={inputCls} />
          </Field>
          <Field label="Reconnect prob." hint="0 = disabled">
            <input type="number" min={0} max={1} step={0.01} value={cfg.reconnectProbability ?? 0}
              onChange={e => num('reconnectProbability', e.target.value)} className={inputCls} />
          </Field>
          <Field label="Spawn delay (ms)">
            <input type="number" min={0} max={5000} value={cfg.spawnDelayMs ?? 100}
              onChange={e => num('spawnDelayMs', e.target.value)} className={inputCls} />
          </Field>
        </div>
      )}

      {/* Feedback */}
      {error && (
        <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded px-3 py-2">
          {error}
        </p>
      )}
      {success && (
        <p className="text-xs text-green-400 bg-green-900/20 border border-green-800 rounded px-3 py-2">
          ✓ {success}
        </p>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-3 pt-1">
        {!isRunning ? (
          <>
            {!matrixMode ? (
              <button
                type="button"
                onClick={handleStart}
                disabled={start.isPending}
                className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-md transition-colors"
              >
                {start.isPending ? 'Starting…' : '▶ Start Benchmark'}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleMatrix}
                disabled={matrix.isPending}
                className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white rounded-md transition-colors"
              >
                {matrix.isPending ? 'Queueing…' : '⚡ Run Matrix (1–50 users)'}
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancel.isPending}
            className="px-4 py-2 text-sm font-medium bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-md transition-colors"
          >
            {cancel.isPending ? 'Cancelling…' : '✕ Cancel'}
          </button>
        )}
      </div>
    </div>
  );
}

const inputCls =
  'w-full bg-zinc-900 border border-zinc-600 rounded text-sm text-zinc-100 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500';

function Field({ label, hint, children, className }: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-xs text-zinc-400 mb-1">
        {label} {hint && <span className="text-zinc-600">({hint})</span>}
      </label>
      {children}
    </div>
  );
}
