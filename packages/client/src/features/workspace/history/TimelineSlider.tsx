import React from 'react';
import type { VersionMeta } from './types';

interface TimelineSliderProps {
  versions: VersionMeta[];
  selectedIndex: number;
  onChange: (index: number) => void;
}

export function TimelineSlider({ versions, selectedIndex, onChange }: TimelineSliderProps) {
  if (versions.length <= 1) return null;

  const max = versions.length - 1;
  const selected = versions[selectedIndex];

  return (
    <div className="px-4 py-3 border-b border-border select-none flex-shrink-0">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-text-muted">Oldest</span>
        {selected && (
          <span className="text-[11px] text-text-secondary font-medium tabular-nums">
            v{selected.versionNum} &mdash; {selectedIndex + 1} / {versions.length}
          </span>
        )}
        <span className="text-[10px] text-text-muted">Latest</span>
      </div>

      {/* Range track wrapper with tick marks */}
      <div className="relative">
        <input
          type="range"
          min={0}
          max={max}
          step={1}
          value={selectedIndex}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full cursor-pointer accent-[var(--color-accent)]"
          style={{ height: '6px' }}
          aria-label="Select version"
        />

        {/* Tick marks for manual / restore versions */}
        {max > 0 && (
          <div className="relative h-1.5 -mt-0.5 pointer-events-none">
            {versions.map((v, i) => {
              if (v.source === 'auto') return null;
              const pct = (i / max) * 100;
              return (
                <div
                  key={v.id}
                  className="absolute w-1 h-1.5 rounded-sm top-0"
                  style={{
                    left: `calc(${pct}% - 2px)`,
                    background:
                      v.source === 'manual'
                        ? 'var(--color-accent)'
                        : 'oklch(0.8 0.18 85)',
                  }}
                  title={v.label ?? (v.source === 'restore' ? 'Restore point' : 'Checkpoint')}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
