import { useEffect, useRef, useState } from 'react';

interface ScrollProgress {
  progress: number;         // 0..1, how far section has been scrolled through viewport
  isInView: boolean;
  hasEntered: boolean;      // once true, stays true
}

/**
 * Tracks scroll progress of a section relative to the viewport.
 * progress = 0 when top of element enters bottom of viewport
 * progress = 1 when bottom of element exits top of viewport
 */
export function useScrollProgress<T extends HTMLElement>(): [
  React.RefObject<T>,
  ScrollProgress,
] {
  const ref = useRef<T>(null);
  const [state, setState] = useState<ScrollProgress>({
    progress: 0,
    isInView: false,
    hasEntered: false,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const total = rect.height + vh;
      const entered = vh - rect.top;
      const raw = entered / total;
      const progress = Math.max(0, Math.min(1, raw));
      const isInView = rect.bottom > 0 && rect.top < vh;

      setState(prev => ({
        progress,
        isInView,
        hasEntered: prev.hasEntered || isInView,
      }));
    };

    window.addEventListener('scroll', update, { passive: true });
    update();

    return () => window.removeEventListener('scroll', update);
  }, []);

  return [ref as React.RefObject<T>, state];
}

/**
 * Simple in-view detection for triggering entrance animations.
 * threshold: fraction of element visible before triggering.
 */
export function useInView<T extends HTMLElement>(
  threshold = 0.15,
): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect(); // fire once
        }
      },
      { threshold },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);

  return [ref as React.RefObject<T>, inView];
}
