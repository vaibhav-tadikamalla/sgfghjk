import React, { useState, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { simulationApi, type SimulationSnapshot, type StartSimulationParams } from './api';

const PRESETS = [10, 50, 100, 500, 1000] as const;

interface Props {
  snapshot: SimulationSnapshot;
}

export function SimulationControls({ snapshot }: Props) {
  const queryClient = useQueryClient();
  const isRunning = snapshot.state === 'running' || snapshot.state === 'starting';
  const isStopping = snapshot.state === 'stopping';

  const [editorCount, setEditorCount] = useState(50);
  const [targetRoom, setTargetRoom] = useState('sim-loadtest');
  const [typingSpeed, setTypingSpeed] = useState(5);
  const [reconnectProb, setReconnectProb] = useState(0.02);
  const [spawnDelay, setSpawnDelay] = useState(50);

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['admin', 'simulation'] }),
    [queryClient],
  );

  const startMutation = useMutation({
    mutationFn: (params: StartSimulationParams) => simulationApi.start(params),
    onSuccess: () => { invalidate(); },
  });

  const stopMutation = useMutation({
    mutationFn: () => simulationApi.stop(),
    onSuccess: () => { invalidate(); },
  });

  const handleStart = () => {
    startMutation.mutate({
      editorCount,
      targetRoom: targetRoom.startsWith('sim-') ? targetRoom : `sim-${targetRoom}`,
      typingSpeed,
      reconnectProbability: reconnectProb,
      spawnDelayMs: spawnDelay,
    });
  };

  return (
    <div className="bg-zinc-800/60 border border-zinc-700 rounded-xl p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-200 tracking-wide uppercase">
          Swarm Controls
        </h2>
        <StatusBadge state={snapshot.state} />
      </div>

      {/* Editor Count */}
      <div className="space-y-2">
        <label className="block text-xs font-medium text-zinc-400">Editor Count</label>
        <div className="flex gap-2 flex-wrap">
          {PRESETS.map(n => (
            <button
              key={n}
              disabled={isRunning}
              onClick={() => setEditorCount(n)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                editorCount === n
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-zinc-700/50 border-zinc-600 text-zinc-300 hover:bg-zinc-700'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {n}
            </button>
          ))}
          <input
            type="number"
            min={1}
            max={1000}
            disabled={isRunning}
            value={editorCount}
            onChange={e => setEditorCount(Math.min(1000, Math.max(1, Number(e.target.value) || 1)))}
            className="w-20 px-2 py-1.5 text-xs rounded-md bg-zinc-700/50 border border-zinc-600 text-zinc-200 disabled:opacity-40"
          />
        </div>
      </div>

      {/* Target Room */}
      <div className="space-y-1">
        <label className="block text-xs font-medium text-zinc-400">Target Room</label>
        <input
          type="text"
          disabled={isRunning}
          value={targetRoom}
          onChange={e => setTargetRoom(e.target.value)}
          placeholder="sim-loadtest"
          className="w-full px-3 py-2 text-sm rounded-md bg-zinc-700/50 border border-zinc-600 text-zinc-200 placeholder-zinc-500 disabled:opacity-40"
        />
        <p className="text-[10px] text-zinc-500">Must start with &quot;sim-&quot; (auto-prefixed if omitted)</p>
      </div>

      {/* Advanced controls row */}
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-1">
          <label className="block text-xs font-medium text-zinc-400">
            Typing Speed <span className="text-zinc-500">chars/s</span>
          </label>
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            disabled={isRunning}
            value={typingSpeed}
            onChange={e => setTypingSpeed(Number(e.target.value))}
            className="w-full accent-blue-500"
          />
          <div className="text-xs text-zinc-400 text-center">{typingSpeed}</div>
        </div>

        <div className="space-y-1">
          <label className="block text-xs font-medium text-zinc-400">
            Reconnect Prob <span className="text-zinc-500">0–1</span>
          </label>
          <input
            type="range"
            min={0}
            max={0.2}
            step={0.01}
            disabled={isRunning}
            value={reconnectProb}
            onChange={e => setReconnectProb(Number(e.target.value))}
            className="w-full accent-blue-500"
          />
          <div className="text-xs text-zinc-400 text-center">{reconnectProb.toFixed(2)}</div>
        </div>

        <div className="space-y-1">
          <label className="block text-xs font-medium text-zinc-400">
            Spawn Delay <span className="text-zinc-500">ms</span>
          </label>
          <input
            type="range"
            min={10}
            max={500}
            step={10}
            disabled={isRunning}
            value={spawnDelay}
            onChange={e => setSpawnDelay(Number(e.target.value))}
            className="w-full accent-blue-500"
          />
          <div className="text-xs text-zinc-400 text-center">{spawnDelay}ms</div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-3 pt-1">
        <button
          onClick={handleStart}
          disabled={isRunning || isStopping || startMutation.isPending}
          className="flex-1 px-4 py-2.5 text-sm font-semibold rounded-lg bg-green-600 hover:bg-green-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {startMutation.isPending ? 'Starting…' : `Start ${editorCount} Editors`}
        </button>
        <button
          onClick={() => stopMutation.mutate()}
          disabled={(!isRunning && !isStopping) || stopMutation.isPending}
          className="flex-1 px-4 py-2.5 text-sm font-semibold rounded-lg bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {stopMutation.isPending || isStopping ? 'Stopping…' : 'Stop Swarm'}
        </button>
      </div>

      {/* Error feedback */}
      {(startMutation.isError || stopMutation.isError) && (
        <div className="bg-red-900/30 border border-red-800 rounded-md p-3 text-xs text-red-300">
          {String(startMutation.error || stopMutation.error)}
        </div>
      )}
    </div>
  );
}

/* ── Status badge ── */

function StatusBadge({ state }: { state: SimulationSnapshot['state'] }) {
  const styles: Record<SimulationSnapshot['state'], string> = {
    idle: 'bg-zinc-700/50 text-zinc-400 border-zinc-600',
    starting: 'bg-yellow-900/50 text-yellow-400 border-yellow-700 animate-pulse',
    running: 'bg-green-900/50 text-green-400 border-green-700',
    stopping: 'bg-orange-900/50 text-orange-400 border-orange-700 animate-pulse',
    stopped: 'bg-zinc-700/50 text-zinc-400 border-zinc-600',
  };

  return (
    <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full border ${styles[state]}`}>
      {state.toUpperCase()}
    </span>
  );
}
