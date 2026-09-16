import { useEffect, useRef, useState } from 'react';

interface MousePosition {
  x: number;  // -1..1 from left to right
  y: number;  // -1..1 from top to bottom
}

/** Normalized mouse position for parallax/R3F camera effects. */
export function useMousePosition(): MousePosition {
  const [pos, setPos] = useState<MousePosition>({ x: 0, y: 0 });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      setPos({
        x: (e.clientX / window.innerWidth) * 2 - 1,
        y: -((e.clientY / window.innerHeight) * 2 - 1),
      });
    };

    window.addEventListener('mousemove', handler, { passive: true });
    return () => window.removeEventListener('mousemove', handler);
  }, []);

  return pos;
}

/** Lerped mouse position for smooth camera movement. */
export function useSmoothedMouse(lerpFactor = 0.05): MousePosition {
  const raw = useMousePosition();
  const smoothed = useRef<MousePosition>({ x: 0, y: 0 });
  const [output, setOutput] = useState<MousePosition>({ x: 0, y: 0 });
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const tick = () => {
      smoothed.current.x += (raw.x - smoothed.current.x) * lerpFactor;
      smoothed.current.y += (raw.y - smoothed.current.y) * lerpFactor;
      setOutput({ ...smoothed.current });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [raw.x, raw.y, lerpFactor]);

  return output;
}
