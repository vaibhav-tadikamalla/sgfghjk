/**
 * admin/BenchmarkControls.tsx
 *
 * Faculty Demo & Production Swarm Test Launcher.
 * Features 1-click presets (10 users default), allowlisted target dropdown,
 * latency/load mode selection, and a prominent "START SWARM TEST" CTA.
 */

import React, { useState, useEffect } from 'react';
import { useStartBenchmark, useCancelBenchmark, useStartMatrix, useBenchmarkTargets } from './benchmarkHooks';
import type { BenchmarkConfig } from './benchmarkApi';

interface Props {
  isRunning: boolean;
  onStarted?: (runId: string) => void;
}

const USER_PRESETS = [2, 5, 10, 20, 50];

export function BenchmarkControls({ isRunning, onStarted }: Props) {
  const start = useStartBenchmark();
  const cancel = useCancelBenchmark();
  const matrix = useStartMatrix();
  const { data: targetsData } = useBenchmarkTargets();

  const allowedTargets = targetsData?.targets ?? [];
  const defaultTarget = allowedTargets[0] ?? (
    `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host.replace(/:\d+$/, '')}:${window.location.port || (window.location.protocol === 'https:' ? '443' : '80')}/ws`
  );

  const [cfg, setCfg] = useState<BenchmarkConfig>({
    userCount: 10,
    durationSeconds: 30,
    warmupSeconds: 10,
    cooldownSeconds: 5,
    typingSpeed: 2,
    reconnectProbability: 0,
    targetUrl: defaultTarget,
    collectResourceMetrics: true,
    benchmarkMode: 'latency',
  });

  // Keep targetUrl updated if targets load asynchronously
  useEffect(() => {
    if (allowedTargets.length > 0 && !allowedTargets.includes(cfg.targetUrl)) {
      setCfg(prev => ({ ...prev, targetUrl: allowedTargets[0]! }));
    }
  }, [allowedTargets]);

  const [matrixMode, setMatrixMode] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function num(field: keyof BenchmarkConfig, value: string) {
    const n = parseFloat(value);
    if (!isNaN(n)) setCfg(prev => ({ ...prev, [field]: n }));
  }

  async function handleStart() {
    setError(null);
    try {
      const result = await start.mutateAsync(cfg);
      if (onStarted) onStarted(result.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleMatrix() {
    setError(null);
    try {
      const result = await matrix.mutateAsync({
        userMatrix: [1, 5, 10, 20, 30, 40, 50],
        typingSpeedMatrix: [2],
        durationSeconds: Math.max(30, cfg.durationSeconds),
        warmupSeconds: cfg.warmupSeconds,
        cooldownSeconds: cfg.cooldownSeconds,
        targetUrl: cfg.targetUrl,
      });
      if (onStarted && result.runIds?.[0]) onStarted(result.runIds[0]);
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

  function getTargetLabel(url: string): string {
    if (url.includes('localhost') || url.includes('127.0.0.1')) {
      return `Local PeerGrid (${url})`;
    }
    if (url.includes('render.com')) {
      return `Deployed Render Instance (${url})`;
    }
    return url;
  }

  return (
    <div className="bg-zinc-800/80 border border-zinc-700/80 rounded-xl p-6 shadow-xl space-y-6">
      {/* Title & Badge */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-700/60 pb-4">
        <div>
          <h3 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
            <span>Configure Swarm Test</span>
            <span className="text-xs px-2 py-0.5 font-medium rounded-full bg-blue-900/60 text-blue-300 border border-blue-700/50">
              Demo Preset: 10 Users
            </span>
          </h3>
          <p className="text-xs text-zinc-400 mt-0.5">
            Spawns real simulated collaborative clients to measure real-time CRDT propagation latency (t₁→t₂).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none bg-zinc-900/60 px-3 py-1.5 rounded-lg border border-zinc-700/50 hover:border-zinc-600 transition-colors">
            <input
              type="checkbox"
              checked={matrixMode}
              onChange={e => setMatrixMode(e.target.checked)}
              className="rounded border-zinc-600 text-blue-600 focus:ring-0"
            />
            Academic Matrix Mode (1–50 Users)
          </label>
        </div>
      </div>

      {/* Preset Buttons for User Count */}
      {!matrixMode && (
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-300 mb-2">
            Simulated Users ({cfg.userCount} selected)
          </label>
          <div className="grid grid-cols-5 gap-2 sm:gap-3">
            {USER_PRESETS.map(count => {
              const active = cfg.userCount === count;
              return (
                <button
                  key={count}
                  type="button"
                  onClick={() => setCfg(prev => ({ ...prev, userCount: count }))}
                  className={`py-3 px-2 rounded-lg text-sm font-bold flex flex-col items-center justify-center transition-all ${
                    active
                      ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/25 ring-2 ring-blue-400 scale-[1.02]'
                      : 'bg-zinc-900/80 text-zinc-300 border border-zinc-700/70 hover:bg-zinc-700/50 hover:text-white'
                  }`}
                >
                  <span className="text-lg">{count}</span>
                  <span className="text-[10px] font-normal opacity-80">
                    {count === 10 ? '★ Recommended' : 'Users'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Primary Parameters Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Custom Users input if not using a preset */}
        {!matrixMode && (
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1">
              Custom User Count <span className="text-zinc-500">(1–200)</span>
            </label>
            <input
              type="number"
              min={1}
              max={200}
              value={cfg.userCount}
              onChange={e => num('userCount', e.target.value)}
              className={inputCls}
            />
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-zinc-300 mb-1">
            Test Duration <span className="text-zinc-500">(Measurement Phase)</span>
          </label>
          <div className="relative">
            <input
              type="number"
              min={10}
              max={600}
              value={cfg.durationSeconds}
              onChange={e => num('durationSeconds', e.target.value)}
              className={inputCls}
            />
            <span className="absolute right-3 top-2 text-xs text-zinc-500">sec</span>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-300 mb-1">
            Typing Rate <span className="text-zinc-500">(Activity Intensity)</span>
          </label>
          <div className="relative">
            <input
              type="number"
              min={0.5}
              max={20}
              step={0.5}
              value={cfg.typingSpeed}
              onChange={e => num('typingSpeed', e.target.value)}
              className={inputCls}
            />
            <span className="absolute right-3 top-2 text-xs text-zinc-500">chars/s</span>
          </div>
        </div>
      </div>

      {/* Target & Mode Selectors */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-zinc-900/60 p-4 rounded-lg border border-zinc-700/60">
        <div>
          <label className="block text-xs font-semibold text-zinc-300 mb-1 flex items-center justify-between">
            <span>Target WebSocket Endpoint</span>
            <span className="text-[10px] text-green-400 font-normal flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              Allowlisted Target
            </span>
          </label>
          {allowedTargets.length > 0 ? (
            <select
              value={cfg.targetUrl}
              onChange={e => setCfg(prev => ({ ...prev, targetUrl: e.target.value }))}
              className={inputCls}
            >
              {allowedTargets.map(target => (
                <option key={target} value={target}>
                  {getTargetLabel(target)}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={cfg.targetUrl}
              readOnly
              className={`${inputCls} opacity-80`}
            />
          )}
          <p className="text-[11px] text-zinc-500 mt-1">
            Enforced by security policy (SSRF-protected allowlist).
          </p>
        </div>

        <div>
          <label className="block text-xs font-semibold text-zinc-300 mb-1 flex items-center justify-between">
            <span>Measurement Mode</span>
            <span className="text-[10px] text-blue-400 font-normal">
              {cfg.benchmarkMode === 'latency' ? 'Academic t₁→t₂' : 'Throughput stress'}
            </span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setCfg(prev => ({ ...prev, benchmarkMode: 'latency' }))}
              className={`py-2 px-3 rounded-lg text-xs font-medium text-left transition-colors border ${
                cfg.benchmarkMode === 'latency'
                  ? 'bg-blue-600/30 border-blue-500 text-blue-200'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <div className="font-bold text-white">Latency Mode</div>
              <div className="text-[10px] opacity-80">Incremental delta ($t_1 \to t_2$)</div>
            </button>
            <button
              type="button"
              onClick={() => setCfg(prev => ({ ...prev, benchmarkMode: 'load' }))}
              className={`py-2 px-3 rounded-lg text-xs font-medium text-left transition-colors border ${
                cfg.benchmarkMode === 'load'
                  ? 'bg-blue-600/30 border-blue-500 text-blue-200'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <div className="font-bold text-white">Load Mode</div>
              <div className="text-[10px] opacity-80">Full-state stress test</div>
            </button>
          </div>
        </div>
      </div>

      {/* Advanced Settings Collapsible */}
      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced(v => !v)}
          className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1.5 transition-colors font-medium"
        >
          <span>{showAdvanced ? '▾' : '▸'}</span>
          <span>Advanced Benchmark Timing (Warmup & Cooldown)</span>
        </button>

        {showAdvanced && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 mt-2 border-t border-zinc-700/40">
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Warm-up (s)</label>
              <input
                type="number"
                min={0}
                max={60}
                value={cfg.warmupSeconds ?? 10}
                onChange={e => num('warmupSeconds', e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Cooldown (s)</label>
              <input
                type="number"
                min={0}
                max={60}
                value={cfg.cooldownSeconds ?? 5}
                onChange={e => num('cooldownSeconds', e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Spawn delay (ms)</label>
              <input
                type="number"
                min={0}
                max={2000}
                value={cfg.spawnDelayMs ?? 100}
                onChange={e => num('spawnDelayMs', e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Metrics capture</label>
              <select
                value={cfg.collectResourceMetrics ? 'yes' : 'no'}
                onChange={e => setCfg(prev => ({ ...prev, collectResourceMetrics: e.target.value === 'yes' }))}
                className={inputCls}
              >
                <option value="yes">CPU & Memory (On)</option>
                <option value="no">CPU & Memory (Off)</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Error message */}
      {error && (
        <div className="p-3 bg-red-900/40 border border-red-700 rounded-lg text-xs text-red-200">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Primary Action Button */}
      <div className="pt-2">
        {!isRunning ? (
          <>
            {!matrixMode ? (
              <button
                type="button"
                onClick={handleStart}
                disabled={start.isPending}
                className="w-full py-4 px-6 rounded-xl text-base font-bold text-white bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-600 hover:from-blue-500 hover:via-indigo-500 hover:to-blue-500 active:scale-[0.99] disabled:opacity-50 transition-all shadow-xl shadow-blue-600/30 flex items-center justify-center gap-3 cursor-pointer"
              >
                {start.isPending ? (
                  <>
                    <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>Launching Swarm Test…</span>
                  </>
                ) : (
                  <>
                    <span className="text-xl">▶</span>
                    <span>START SWARM TEST ({cfg.userCount} SIMULATED USERS)</span>
                  </>
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleMatrix}
                disabled={matrix.isPending}
                className="w-full py-4 px-6 rounded-xl text-base font-bold text-white bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50 transition-all shadow-xl shadow-purple-600/30 flex items-center justify-center gap-3 cursor-pointer"
              >
                {matrix.isPending ? 'Queuing Matrix Runs…' : '⚡ START ACADEMIC MATRIX (1 TO 50 USERS)'}
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancel.isPending}
            className="w-full py-4 px-6 rounded-xl text-base font-bold text-white bg-red-700 hover:bg-red-600 disabled:opacity-50 transition-all shadow-xl shadow-red-700/30 flex items-center justify-center gap-3 cursor-pointer"
          >
            {cancel.isPending ? 'Cancelling Test…' : '✕ CANCEL RUNNING TEST'}
          </button>
        )}
      </div>
    </div>
  );
}

const inputCls =
  'w-full bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-100 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-colors';
