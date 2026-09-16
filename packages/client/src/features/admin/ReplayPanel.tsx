import React, { useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  simulationApi,
  type ReplaySnapshot,
  type ReplayTrace,
  type ReplayTraceEvent,
  type ReplayMode,
} from './api';

interface Props {
  snapshot: ReplaySnapshot;
  clusterRunning: boolean;
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function fmtMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

const KIND_COLORS: Record<string, string> = {
  inject: 'text-red-400',
  recover: 'text-green-400',
  'scenario-action': 'text-blue-400',
  log: 'text-zinc-400',
};

const KIND_ICONS: Record<string, string> = {
  inject: '💥',
  recover: '✅',
  'scenario-action': '🎬',
  log: '📝',
};

/* ── Component ─────────────────────────────────────────────────────────── */

export function ReplayPanel({ snapshot, clusterRunning }: Props) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'simulation', 'replay'] });
    queryClient.invalidateQueries({ queryKey: ['admin', 'simulation', 'cluster'] });
  };

  const [mode, setMode] = useState<ReplayMode>('continuous');
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [traces, setTraces] = useState<ReplayTrace[]>([]);
  const [tracesLoaded, setTracesLoaded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Mutations ────────────────────────────────────────────────────────
  const startRecording = useMutation({
    mutationFn: () => simulationApi.startRecording(),
    onSuccess: invalidate,
  });

  const stopRecording = useMutation({
    mutationFn: () => simulationApi.stopRecording(),
    onSuccess: () => {
      invalidate();
      loadTraces();
    },
  });

  const startReplay = useMutation({
    mutationFn: () => {
      if (!selectedTraceId) throw new Error('No trace selected');
      return simulationApi.startReplay(selectedTraceId, mode);
    },
    onSuccess: invalidate,
  });

  const stopReplay = useMutation({
    mutationFn: () => simulationApi.stopReplay(),
    onSuccess: invalidate,
  });

  const pauseReplay = useMutation({
    mutationFn: () => simulationApi.pauseReplay(),
    onSuccess: invalidate,
  });

  const resumeReplay = useMutation({
    mutationFn: () => simulationApi.resumeReplay(),
    onSuccess: invalidate,
  });

  const stepForward = useMutation({
    mutationFn: () => simulationApi.stepForward(),
    onSuccess: invalidate,
  });

  const importTrace = useMutation({
    mutationFn: (trace: ReplayTrace) => simulationApi.importTrace(trace),
    onSuccess: () => {
      invalidate();
      loadTraces();
    },
  });

  const loadTraces = async () => {
    try {
      const res = await simulationApi.getTraces();
      setTraces(res.traces);
      setTracesLoaded(true);
    } catch {
      /* noop */
    }
  };

  if (!tracesLoaded) {
    loadTraces();
  }

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const trace = JSON.parse(reader.result as string) as ReplayTrace;
        importTrace.mutate(trace);
      } catch {
        alert('Invalid JSON trace file');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleExportTrace = async (traceId: string) => {
    try {
      const res = await simulationApi.getTrace(traceId);
      const blob = new Blob([JSON.stringify(res.trace, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${traceId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert('Failed to export trace');
    }
  };

  const isIdle = snapshot.state === 'idle';
  const isRecording = snapshot.state === 'recording';
  const isReplaying = snapshot.state === 'replaying';
  const isStepping = snapshot.state === 'stepping';
  const isPaused = snapshot.state === 'paused';
  const isCompleted = snapshot.state === 'completed';
  const isActive = isReplaying || isStepping || isPaused;

  return (
    <div className="space-y-6">
      {/* ── State Banner ──────────────────────────────────────────────── */}
      <div className="bg-zinc-800/60 border border-zinc-700 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-200 uppercase tracking-wide">
            Deterministic Replay
          </h3>
          <span
            className={`text-xs px-2 py-0.5 rounded-full border ${
              isRecording
                ? 'bg-red-900/50 text-red-400 border-red-800 animate-pulse'
                : isReplaying
                  ? 'bg-blue-900/50 text-blue-400 border-blue-800 animate-pulse'
                  : isStepping
                    ? 'bg-yellow-900/50 text-yellow-400 border-yellow-800'
                    : isPaused
                      ? 'bg-orange-900/50 text-orange-400 border-orange-800'
                      : isCompleted
                        ? 'bg-green-900/50 text-green-400 border-green-800'
                        : 'bg-zinc-800 text-zinc-400 border-zinc-700'
            }`}
          >
            {snapshot.state}
          </span>
        </div>

        {/* ── Recording Controls ──────────────────────────────────────── */}
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-zinc-400 uppercase">Recording</h4>
          <div className="flex items-center gap-2">
            <button
              disabled={!clusterRunning || isRecording || isActive}
              onClick={() => startRecording.mutate()}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 hover:bg-red-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition"
            >
              ⏺ Start Recording
            </button>
            <button
              disabled={!isRecording}
              onClick={() => stopRecording.mutate()}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-600 hover:bg-zinc-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition"
            >
              ⏹ Stop Recording
            </button>
            {isRecording && (
              <span className="text-xs text-red-400 animate-pulse">● Recording…</span>
            )}
          </div>
        </div>

        {/* ── Replay Controls ─────────────────────────────────────────── */}
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-zinc-400 uppercase">Replay</h4>

          {/* Mode Selector */}
          <div className="flex items-center gap-3">
            <label className="text-xs text-zinc-400">Mode:</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as ReplayMode)}
              disabled={isActive || isRecording}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 disabled:opacity-50"
            >
              <option value="continuous">Continuous</option>
              <option value="step">Step-by-Step</option>
            </select>
          </div>

          {/* Trace Selector */}
          <div className="flex items-center gap-2">
            <select
              value={selectedTraceId ?? ''}
              onChange={(e) => setSelectedTraceId(e.target.value || null)}
              disabled={isActive || isRecording}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 flex-1 disabled:opacity-50"
            >
              <option value="">— Select a trace —</option>
              {traces.map((t) => (
                <option key={t.traceId} value={t.traceId}>
                  {t.traceId} ({t.events.length} events, {fmtMs(t.durationMs)})
                </option>
              ))}
            </select>
            <button
              onClick={() => loadTraces()}
              className="px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition"
              title="Refresh traces"
            >
              🔄
            </button>
          </div>

          {/* Playback Buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              disabled={!clusterRunning || !selectedTraceId || isActive || isRecording}
              onClick={() => startReplay.mutate()}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition"
            >
              ▶ Start Replay
            </button>
            <button
              disabled={!isActive}
              onClick={() => stopReplay.mutate()}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-600 hover:bg-zinc-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition"
            >
              ⏹ Stop
            </button>
            <button
              disabled={!isReplaying}
              onClick={() => pauseReplay.mutate()}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-orange-600 hover:bg-orange-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition"
            >
              ⏸ Pause
            </button>
            <button
              disabled={!isPaused}
              onClick={() => resumeReplay.mutate()}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-green-600 hover:bg-green-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition"
            >
              ▶ Resume
            </button>
            <button
              disabled={!isStepping}
              onClick={() => stepForward.mutate()}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-yellow-600 hover:bg-yellow-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition"
            >
              ⏭ Step
            </button>
          </div>
        </div>

        {/* ── Import / Export ─────────────────────────────────────────── */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition"
          >
            📥 Import Trace
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleFileImport}
            className="hidden"
          />
          {selectedTraceId && (
            <button
              onClick={() => handleExportTrace(selectedTraceId)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition"
            >
              📤 Export Selected
            </button>
          )}
        </div>
      </div>

      {/* ── Progress + Timeline ───────────────────────────────────────── */}
      {(isActive || isCompleted) && (
        <div className="bg-zinc-800/60 border border-zinc-700 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-zinc-200 uppercase tracking-wide">
            Replay Progress
          </h3>

          {/* Progress Bar */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>
                Event {snapshot.currentEventIndex + 1} / {snapshot.traceEventCount}
              </span>
              <span>{Math.round(snapshot.progress)}%</span>
            </div>
            <div className="w-full bg-zinc-900 rounded-full h-2 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  isCompleted ? 'bg-green-500' : 'bg-blue-500'
                }`}
                style={{ width: `${Math.min(100, snapshot.progress)}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-zinc-500">
              <span>{fmtMs(snapshot.elapsedMs)}</span>
              <span>{fmtMs(snapshot.totalDurationMs)}</span>
            </div>
          </div>

          {/* Current / Next Event */}
          <div className="grid md:grid-cols-2 gap-3">
            {snapshot.currentEvent && (
              <EventCard label="Current Event" event={snapshot.currentEvent} />
            )}
            {snapshot.nextEvent && (
              <EventCard label="Next Event" event={snapshot.nextEvent} />
            )}
          </div>

          {/* Replay Timeline (mini visualization) */}
          {snapshot.traceEventCount > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs font-medium text-zinc-400 uppercase">Timeline</h4>
              <div className="flex gap-px h-6 rounded overflow-hidden bg-zinc-900">
                {Array.from({ length: Math.min(80, snapshot.traceEventCount) }).map((_, i) => {
                  const idx = Math.floor(
                    (i / Math.min(80, snapshot.traceEventCount)) * snapshot.traceEventCount
                  );
                  const executed = idx <= snapshot.currentEventIndex;
                  const isCurrent = idx === snapshot.currentEventIndex;
                  return (
                    <div
                      key={i}
                      className={`flex-1 transition-all duration-200 ${
                        isCurrent
                          ? 'bg-yellow-400'
                          : executed
                            ? 'bg-blue-600'
                            : 'bg-zinc-700'
                      }`}
                      title={`Event ${idx + 1}`}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Executed Events Log ───────────────────────────────────────── */}
      {snapshot.executedEvents.length > 0 && (
        <div className="bg-zinc-800/60 border border-zinc-700 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-200 uppercase tracking-wide">
              Executed Events
            </h3>
            <span className="text-xs text-zinc-500">
              {snapshot.executedEvents.length} events
              {snapshot.pendingEvents > 0 && ` · ${snapshot.pendingEvents} pending`}
            </span>
          </div>
          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
            {snapshot.executedEvents
              .slice()
              .reverse()
              .map((evt) => (
                <EventRow key={`${evt.seq}-${evt.timestamp}`} event={evt} />
              ))}
          </div>
        </div>
      )}

      {/* ── Replay Log ────────────────────────────────────────────────── */}
      {snapshot.replayLog.length > 0 && (
        <div className="bg-zinc-800/60 border border-zinc-700 rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-semibold text-zinc-200 uppercase tracking-wide">
            Replay Log
          </h3>
          <div className="space-y-0.5 max-h-48 overflow-y-auto font-mono text-xs text-zinc-400 pr-1">
            {snapshot.replayLog
              .slice()
              .reverse()
              .map((entry, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-zinc-600 shrink-0">{fmtTime(entry.timestamp)}</span>
                  <span>{entry.message}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* ── Stored Traces ─────────────────────────────────────────────── */}
      {traces.length > 0 && (
        <div className="bg-zinc-800/60 border border-zinc-700 rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-semibold text-zinc-200 uppercase tracking-wide">
            Stored Traces ({traces.length})
          </h3>
          <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
            {traces.map((t) => (
              <div
                key={t.traceId}
                className={`flex items-center justify-between bg-zinc-900 rounded-lg px-3 py-2 border ${
                  selectedTraceId === t.traceId
                    ? 'border-blue-600'
                    : 'border-zinc-800'
                } cursor-pointer hover:border-zinc-600 transition`}
                onClick={() => setSelectedTraceId(t.traceId)}
              >
                <div className="space-y-0.5">
                  <div className="text-xs text-zinc-200 font-medium">
                    {t.traceId}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {t.summary.totalEvents} events · {t.summary.totalInjections} injections ·{' '}
                    {t.summary.totalRecoveries} recoveries · {fmtMs(t.durationMs)}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleExportTrace(t.traceId);
                  }}
                  className="px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-300 transition"
                >
                  📤
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────────── */

function EventCard({ label, event }: { label: string; event: ReplayTraceEvent }) {
  return (
    <div className="bg-zinc-900 rounded-lg p-3 border border-zinc-800 space-y-1">
      <div className="text-xs text-zinc-500 uppercase">{label}</div>
      <div className={`text-sm font-medium ${KIND_COLORS[event.kind] ?? 'text-zinc-300'}`}>
        {KIND_ICONS[event.kind] ?? '•'} {event.description}
      </div>
      <div className="flex gap-3 text-xs text-zinc-500">
        <span>#{event.seq}</span>
        <span>+{fmtMs(event.offsetMs)}</span>
        {event.failureType && <span className="text-zinc-400">{event.failureType}</span>}
        {event.targetNodeId && <span className="text-zinc-400">→ {event.targetNodeId}</span>}
      </div>
    </div>
  );
}

function EventRow({ event }: { event: ReplayTraceEvent }) {
  return (
    <div className="flex items-center gap-2 text-xs py-1 px-2 rounded hover:bg-zinc-900/60 transition">
      <span className="w-6 text-right text-zinc-600 shrink-0">#{event.seq}</span>
      <span className="shrink-0">{KIND_ICONS[event.kind] ?? '•'}</span>
      <span className={`truncate ${KIND_COLORS[event.kind] ?? 'text-zinc-300'}`}>
        {event.description}
      </span>
      <span className="ml-auto shrink-0 text-zinc-600">+{fmtMs(event.offsetMs)}</span>
    </div>
  );
}
