/**
 * PeerGrid Landing — "The Signal"
 *
 * A scroll-based cinematic narrative experience.
 * No traditional sections. No feature grids. No pricing tables.
 * The scroll IS the story.
 *
 * The page unfolds in 5 acts:
 *   1. The Void       — Cursor appears, text types, brand reveals
 *   2. Emergence      — Particles coalesce into a living network (R3F)
 *   3. Collaboration  — Two editors synchronize in real-time
 *   4. Resilience     — The network breaks and heals itself (R3F)
 *   5. Finale         — Scale metrics, deploy command, CTA
 */

import { Suspense, lazy } from 'react';
import { useLenis } from '@/hooks/useLenis';
import Cursor from '@/components/Cursor';
import Navbar from '@/components/Navbar';
import ScrollProgress from '@/components/ScrollProgress';
import Act1_Void from '@/acts/Act1_Void';

// Lazy-load heavier acts (R3F scenes, etc.)
const Act2_Emergence = lazy(() => import('@/acts/Act2_Emergence'));
const Act3_Sync = lazy(() => import('@/acts/Act3_Sync'));
const Act4_Resilience = lazy(() => import('@/acts/Act4_Resilience'));
const Act5_Finale = lazy(() => import('@/acts/Act5_Finale'));

// Loading placeholder matching approximate act heights
function ActFallback({ height = '500vh' }: { height?: string }) {
  return <div className="bg-void" style={{ height }} />;
}

export default function App() {
  useLenis();

  return (
    <div className="min-h-screen bg-void text-white noise-overlay" style={{ overflowX: 'clip' }}>
      {/* Custom cursor (desktop only) */}
      <Cursor />

      {/* Floating nav (appears after hero) */}
      <Navbar />

      {/* Scroll progress indicator (thin left-edge line) */}
      <ScrollProgress />

      {/* The narrative */}
      <main>
        {/* Act 1: The Void — eagerly loaded (first paint) */}
        <Act1_Void />

        {/* Act 2: Emergence — R3F network formation */}
        <Suspense fallback={<ActFallback height="500vh" />}>
          <Act2_Emergence />
        </Suspense>

        {/* Act 3: Collaboration — dual editor sync */}
        <Suspense fallback={<ActFallback height="450vh" />}>
          <Act3_Sync />
        </Suspense>

        {/* Act 4: Resilience — chaos and self-healing */}
        <Suspense fallback={<ActFallback height="500vh" />}>
          <Act4_Resilience />
        </Suspense>

        {/* Act 5: Finale — metrics, deploy, CTA */}
        <Suspense fallback={<ActFallback height="400vh" />}>
          <Act5_Finale />
        </Suspense>
      </main>

      {/* Minimal footer */}
      <footer className="py-12 text-center border-t border-white/[0.04]">
        <p className="text-xs text-white/20 font-mono tracking-wider">
          © {new Date().getFullYear()} PeerGrid · Built by Vaibhav Tadikamalla
        </p>
      </footer>
    </div>
  );
}
