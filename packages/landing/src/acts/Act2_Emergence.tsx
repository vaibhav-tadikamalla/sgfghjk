/**
 * Act 2: Emergence
 *
 * Scattered particles coalesce into a living network mesh.
 * Full-viewport R3F canvas pinned to screen, driven by scroll progress.
 * Multiple text overlays and feature callouts fill every scroll region.
 *
 * Scroll phases (no dead zones):
 *   0.00–0.05  Fade in, "Imagine a network" text
 *   0.05–0.25  Particles begin migrating
 *   0.20–0.30  "Nodes discovering each other" text
 *   0.25–0.55  Particles reach target positions (Fibonacci sphere)
 *   0.40–0.55  Feature callout: "Peer-to-peer topology"
 *   0.50–0.70  Edges appear connecting nearby nodes
 *   0.55–0.65  Feature callout: "No central server"
 *   0.60–0.80  Data packets begin traveling edges
 *   0.65–0.75  Feature callout: "CRDT synchronization"
 *   0.75–0.88  Main text overlay: "A living network..."
 *   0.88–1.00  Fade out
 */

import { useRef } from 'react';
import { motion, useScroll, useTransform, MotionValue } from 'framer-motion';
import NetworkCanvas from '@/scenes/NetworkCanvas';

// ─── Floating annotation ───────────────────────────────────────────────────
function FloatingCallout({
  text,
  subtext,
  position,
  showAt,
  hideAt,
  scrollYProgress,
}: {
  text: string;
  subtext?: string;
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  showAt: number;
  hideAt: number;
  scrollYProgress: MotionValue<number>;
}) {
  const opacity = useTransform(
    scrollYProgress,
    [showAt, showAt + 0.04, hideAt - 0.03, hideAt],
    [0, 1, 1, 0]
  );
  const y = useTransform(
    scrollYProgress,
    [showAt, showAt + 0.05],
    [15, 0]
  );

  const posClasses = {
    'top-left': 'top-24 left-8 md:left-16',
    'top-right': 'top-24 right-8 md:right-16',
    'bottom-left': 'bottom-32 left-8 md:left-16',
    'bottom-right': 'bottom-32 right-8 md:right-16',
  };

  return (
    <motion.div
      className={`absolute ${posClasses[position]} z-10 pointer-events-none max-w-xs`}
      style={{ opacity, y }}
    >
      <div className="flex items-center gap-2 mb-1">
        <div className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse" />
        <span className="text-xs font-mono text-accent-blue/80 tracking-wider uppercase">
          {text}
        </span>
      </div>
      {subtext && (
        <p className="text-[11px] text-white/35 font-mono pl-3.5">
          {subtext}
        </p>
      )}
    </motion.div>
  );
}

// ─── Center text overlay ───────────────────────────────────────────────────
function CenterText({
  text,
  showAt,
  hideAt,
  scrollYProgress,
  position = 'center',
}: {
  text: string;
  showAt: number;
  hideAt: number;
  scrollYProgress: MotionValue<number>;
  position?: 'center' | 'top' | 'bottom';
}) {
  const opacity = useTransform(
    scrollYProgress,
    [showAt, showAt + 0.04, hideAt - 0.03, hideAt],
    [0, 0.7, 0.7, 0]
  );
  const y = useTransform(
    scrollYProgress,
    [showAt, showAt + 0.04],
    [20, 0]
  );

  const posClass =
    position === 'top'
      ? 'top-28 left-1/2 -translate-x-1/2'
      : position === 'bottom'
        ? 'bottom-28 left-1/2 -translate-x-1/2'
        : 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2';

  return (
    <motion.div
      className={`absolute ${posClass} z-10 pointer-events-none text-center`}
      style={{ opacity, y }}
    >
      <p className="text-sm md:text-base font-light text-white/50 italic tracking-wide">
        {text}
      </p>
    </motion.div>
  );
}

// ─── Main Act ──────────────────────────────────────────────────────────────
export default function Act2_Emergence() {
  const containerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(0);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  });

  scrollYProgress.on('change', (v) => {
    progressRef.current = v;
  });

  // ── Act entry/exit ──
  const actOpacity = useTransform(
    scrollYProgress,
    [0, 0.04, 0.90, 1],
    [0, 1, 1, 0]
  );

  // ── Ambient glow ──
  const glowOpacity = useTransform(
    scrollYProgress,
    [0.15, 0.45, 0.7, 0.9],
    [0, 0.12, 0.18, 0]
  );

  // ── Main text overlay ──
  const mainTextOpacity = useTransform(scrollYProgress, [0.75, 0.82, 0.88, 0.92], [0, 1, 1, 0]);
  const mainTextY = useTransform(scrollYProgress, [0.75, 0.82], [30, 0]);

  // ── Node count indicator ──
  const nodeCountOpacity = useTransform(
    scrollYProgress,
    [0.3, 0.38, 0.72, 0.78],
    [0, 1, 1, 0]
  );

  // ── Connection count ──
  const connCountOpacity = useTransform(
    scrollYProgress,
    [0.48, 0.55, 0.72, 0.78],
    [0, 1, 1, 0]
  );

  return (
    <section
      ref={containerRef}
      className="relative bg-void"
      style={{ height: '500vh' }}
    >
      <div className="act-viewport">
        <motion.div className="absolute inset-0" style={{ opacity: actOpacity }}>
          {/* R3F Network (formation mode) */}
          <NetworkCanvas progress={progressRef} mode="formation" />

          {/* Ambient glow */}
          <motion.div
            className="absolute inset-0 pointer-events-none"
            style={{
              opacity: glowOpacity,
              background:
                'radial-gradient(ellipse 50% 50% at 50% 50%, rgba(41,121,255,0.3) 0%, transparent 60%)',
            }}
          />

          {/* Early narrative text */}
          <CenterText
            text="Imagine a network with no center..."
            showAt={0.0}
            hideAt={0.12}
            scrollYProgress={scrollYProgress}
            position="bottom"
          />

          {/* Discovery text */}
          <CenterText
            text="Nodes discovering each other, forming connections..."
            showAt={0.18}
            hideAt={0.32}
            scrollYProgress={scrollYProgress}
            position="bottom"
          />

          {/* Feature callouts at different corners */}
          <FloatingCallout
            text="Peer-to-peer topology"
            subtext="No central server. No single point of failure."
            position="top-left"
            showAt={0.38}
            hideAt={0.52}
            scrollYProgress={scrollYProgress}
          />

          <FloatingCallout
            text="Self-organizing mesh"
            subtext="Nodes dynamically join and route data."
            position="top-right"
            showAt={0.48}
            hideAt={0.62}
            scrollYProgress={scrollYProgress}
          />

          <FloatingCallout
            text="CRDT synchronization"
            subtext="Conflict-free data merging across all nodes."
            position="bottom-left"
            showAt={0.58}
            hideAt={0.72}
            scrollYProgress={scrollYProgress}
          />

          {/* Live counters */}
          <motion.div
            className="absolute top-16 right-8 md:right-16 z-10 pointer-events-none"
            style={{ opacity: nodeCountOpacity }}
          >
            <div className="text-right">
              <div className="text-2xl md:text-3xl font-black text-gradient-blue">70</div>
              <div className="text-[9px] font-mono text-white/30 tracking-widest">ACTIVE NODES</div>
            </div>
          </motion.div>

          <motion.div
            className="absolute top-32 right-8 md:right-16 z-10 pointer-events-none"
            style={{ opacity: connCountOpacity }}
          >
            <div className="text-right">
              <div className="text-2xl md:text-3xl font-black text-gradient-violet">120</div>
              <div className="text-[9px] font-mono text-white/30 tracking-widest">CONNECTIONS</div>
            </div>
          </motion.div>

          {/* Main text overlay */}
          <motion.div
            className="absolute inset-0 flex items-end justify-center pb-24 pointer-events-none"
            style={{ opacity: mainTextOpacity, y: mainTextY }}
          >
            <div className="text-center max-w-2xl px-8">
              <p className="text-[clamp(1.2rem,2.5vw,1.8rem)] font-light text-white/70 leading-relaxed">
                A living network.{' '}
                <span className="text-white/90 font-medium">
                  Every node a collaborator.
                </span>
              </p>
              <p className="mt-4 text-sm text-white/30 font-mono tracking-wide">
                70 nodes · 120 connections · zero single points of failure
              </p>
              <div className="mt-4 flex items-center justify-center gap-6">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-accent-blue" />
                  <span className="text-[10px] text-white/30 font-mono">Healthy</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-accent-cyan" />
                  <span className="text-[10px] text-white/30 font-mono">Synced</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-8 h-px bg-accent-blue/50" />
                  <span className="text-[10px] text-white/30 font-mono">Connection</span>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
