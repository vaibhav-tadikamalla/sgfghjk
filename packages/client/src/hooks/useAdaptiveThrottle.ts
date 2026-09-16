import { useCallback, useRef } from 'react';

export function useAdaptiveThrottle() {
  const lastCallRef = useRef<number>(0);
  const intervalRef = useRef<number>(66); // Default: ~15Hz

  const throttle = useCallback(<T extends (...args: any[]) => void>(fn: T) => {
    return (...args: Parameters<T>) => {
      const now = Date.now();
      if (now - lastCallRef.current >= intervalRef.current) {
        lastCallRef.current = now;
        fn(...args);
      }
    };
  }, []);

  const setRate = useCallback((hz: number) => {
    intervalRef.current = Math.floor(1000 / hz);
  }, []);

  return { throttle, setRate };
}
