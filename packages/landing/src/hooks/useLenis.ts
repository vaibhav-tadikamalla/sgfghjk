import { useEffect, useRef } from 'react';
import Lenis from '@studio-freight/lenis';

let lenisInstance: Lenis | null = null;

/**
 * Initializes Lenis smooth scrolling globally.
 * Call once at the App level; subsequent calls are no-ops.
 */
export function useLenis() {
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (lenisInstance) return;

    lenisInstance = new Lenis({
      duration: 1.6,
      easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      orientation: 'vertical',
      gestureOrientation: 'vertical',
      smoothWheel: true,
      wheelMultiplier: 0.7,
      touchMultiplier: 1.5,
      infinite: false,
    });

    function raf(time: number) {
      lenisInstance?.raf(time);
      rafRef.current = requestAnimationFrame(raf);
    }

    rafRef.current = requestAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(rafRef.current);
      lenisInstance?.destroy();
      lenisInstance = null;
    };
  }, []);

  return lenisInstance;
}

/** Scroll to a specific element. */
export function scrollTo(target: string | HTMLElement, offset = 0) {
  lenisInstance?.scrollTo(target, { offset });
}
