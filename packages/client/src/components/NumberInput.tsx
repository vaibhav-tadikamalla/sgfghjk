import React, { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/utils/cn';

interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  unit?: string;
  decimals?: number;
  className?: string;
}

export function NumberInput({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  label,
  unit,
  decimals = 0,
  className,
}: NumberInputProps) {
  const [isFocused, setIsFocused] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, startValue: 0 });

  const format = (v: number) => decimals > 0 ? v.toFixed(decimals) : Math.round(v).toString();

  const clampedValue = Math.min(max, Math.max(min, value));

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (isFocused) return;
    e.preventDefault();
    isDraggingRef.current = false;
    dragStartRef.current = { x: e.clientX, startValue: clampedValue };

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - dragStartRef.current.x;
      if (Math.abs(delta) > 3) isDraggingRef.current = true;
      const newValue = Math.min(max, Math.max(min, dragStartRef.current.startValue + delta * step));
      onChange(decimals > 0 ? parseFloat(newValue.toFixed(decimals)) : Math.round(newValue));
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'ew-resize';
  }, [isFocused, clampedValue, min, max, step, onChange, decimals]);

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(true);
    setInputValue(format(clampedValue));
    e.target.select();
  };

  const handleBlur = () => {
    setIsFocused(false);
    const parsed = parseFloat(inputValue);
    if (!isNaN(parsed)) {
      onChange(Math.min(max, Math.max(min, decimals > 0 ? parsed : Math.round(parsed))));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') {
      setIsFocused(false);
      setInputValue(format(clampedValue));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(Math.min(max, clampedValue + step));
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(Math.max(min, clampedValue - step));
    }
  };

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && <span className="label">{label}</span>}
      <div className="relative flex items-center">
        <input
          type="text"
          value={isFocused ? inputValue : format(clampedValue)}
          onChange={(e) => setInputValue(e.target.value)}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          onMouseDown={handleMouseDown}
          className={cn(
            'w-full h-7 px-2 rounded-md text-xs text-text-primary',
            'bg-surface-3 border border-border',
            'focus:outline-none focus:border-accent',
            'transition-colors duration-150',
            !isFocused && 'cursor-ew-resize',
            unit && 'pr-6',
          )}
        />
        {unit && (
          <span className="absolute right-2 text-xs text-text-muted pointer-events-none">{unit}</span>
        )}
      </div>
    </div>
  );
}
