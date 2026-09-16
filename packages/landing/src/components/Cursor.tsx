import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';

/**
 * Smooth custom cursor that replaces the default OS cursor.
 * A small dot (16px) + larger ring (40px) that lags behind.
 */
export default function Cursor() {
  const dotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const ringPos = useRef({ x: 0, y: 0 });
  const mousePos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      mousePos.current = { x: e.clientX, y: e.clientY };
      if (dotRef.current) {
        dotRef.current.style.left = `${e.clientX}px`;
        dotRef.current.style.top = `${e.clientY}px`;
      }
    };

    let raf: number;
    const animate = () => {
      ringPos.current.x += (mousePos.current.x - ringPos.current.x) * 0.12;
      ringPos.current.y += (mousePos.current.y - ringPos.current.y) * 0.12;
      if (ringRef.current) {
        ringRef.current.style.left = `${ringPos.current.x}px`;
        ringRef.current.style.top = `${ringPos.current.y}px`;
      }
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);

    window.addEventListener('mousemove', onMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <>
      {/* Dot */}
      <div
        ref={dotRef}
        className="pointer-events-none fixed -translate-x-1/2 -translate-y-1/2
                   w-3 h-3 rounded-full bg-white mix-blend-difference"
        style={{ left: '-100px', top: '-100px', zIndex: 9999 }}
      />
      {/* Lagged ring */}
      <motion.div
        ref={ringRef}
        className="pointer-events-none fixed -translate-x-1/2 -translate-y-1/2"
        style={{ left: '-100px', top: '-100px', zIndex: 9998 }}
      >
        <div
          className="w-9 h-9 rounded-full border border-white/30 mix-blend-difference"
          style={{ transition: 'width 0.2s, height 0.2s' }}
        />
      </motion.div>
    </>
  );
}
