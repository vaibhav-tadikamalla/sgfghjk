import React, { useCallback, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { cn } from '@/lib/utils/cn';
import { motion, AnimatePresence } from 'framer-motion';

const PRESET_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e',
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#ffffff', '#64748b',
  'transparent', '#000000',
];

interface ColorPickerProps {
  color: string;
  onChange: (color: string) => void;
  label?: string;
}

export function ColorPicker({ color, onChange, label }: ColorPickerProps) {
  const [hexValue, setHexValue] = useState(color === 'transparent' ? '' : color);

  const handlePreset = useCallback((c: string) => {
    onChange(c);
    setHexValue(c === 'transparent' ? '' : c);
  }, [onChange]);

  const handleHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setHexValue(val);
    if (/^#[0-9A-Fa-f]{6}$/.test(val) || /^#[0-9A-Fa-f]{3}$/.test(val)) {
      onChange(val);
    }
  };

  const displayColor = color === 'transparent'
    ? 'transparent'
    : color;

  return (
    <div className="flex flex-col gap-1">
      {label && <span className="label">{label}</span>}
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            className={cn(
              'w-full h-7 rounded-md border border-border',
              'flex items-center gap-2 px-2 cursor-pointer',
              'hover:border-border-strong transition-colors',
              'bg-surface-3',
            )}
          >
            <div
              className="w-4 h-4 rounded-sm border border-border flex-shrink-0"
              style={{
                background: displayColor === 'transparent'
                  ? 'repeating-conic-gradient(#555 0% 25%, transparent 0% 50%) 0 0 / 8px 8px'
                  : displayColor,
              }}
            />
            <span className="text-xs text-text-secondary truncate">
              {color === 'transparent' ? 'None' : color}
            </span>
          </button>
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            side="left"
            align="start"
            sideOffset={8}
            className="z-50"
          >
            <AnimatePresence>
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.12 }}
                className="glass rounded-xl p-3 w-44 shadow-glass"
              >
                {/* Presets */}
                <div className="grid grid-cols-7 gap-1.5 mb-3">
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => handlePreset(c)}
                      className={cn(
                        'w-5 h-5 rounded-md border transition-all hover:scale-110',
                        color === c ? 'border-accent ring-1 ring-accent' : 'border-border',
                      )}
                      style={{
                        background: c === 'transparent'
                          ? 'repeating-conic-gradient(#555 0% 25%, transparent 0% 50%) 0 0 / 6px 6px'
                          : c,
                      }}
                      title={c}
                    />
                  ))}
                </div>

                {/* Hex input */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-muted">#</span>
                  <input
                    type="text"
                    value={hexValue.replace(/^#/, '')}
                    onChange={(e) => handleHexChange({ ...e, target: { ...e.target, value: `#${e.target.value}` } } as any)}
                    placeholder="6366f1"
                    maxLength={6}
                    className={cn(
                      'flex-1 h-6 px-1.5 rounded text-xs',
                      'bg-surface-3 border border-border text-text-primary',
                      'focus:outline-none focus:border-accent',
                    )}
                  />
                </div>
              </motion.div>
            </AnimatePresence>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
