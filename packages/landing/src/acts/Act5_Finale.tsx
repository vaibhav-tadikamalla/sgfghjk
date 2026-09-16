/**
 * Act 5: Finale
 *
 * Scale metrics roll up, a deploy command types itself, and the CTA appears.
 * The emotional payoff — from awe to motivation.
 *
 * Scroll phases (enriched, no dead zones):
 *   0.0–0.06  Section label
 *   0.05–0.28 Metric counters roll up
 *   0.18–0.45 Scale visualization (concentric rings)
 *   0.28–0.38 "Designed for scale" narrative text
 *   0.38–0.57 Deploy code snippet types itself
 *   0.57–0.70 CTA buttons reveal
 *   0.68–0.82 Tech stack / integration badges
 *   0.80–0.90 Final tagline
 *   0.88–1.00 "Start building" closing message + fade
 */

import { useRef, useMemo, useEffect, useState } from 'react';
import {
  motion,
  useScroll,
  useTransform,
  useMotionValueEvent,
  MotionValue,
} from 'framer-motion';

// ─── Animated counter ──────────────────────────────────────────────────────
function AnimatedCounter({
  target,
  suffix,
  prefix,
  label,
  scrollYProgress,
  startAt,
  endAt,
}: {
  target: number;
  suffix?: string;
  prefix?: string;
  label: string;
  scrollYProgress: MotionValue<number>;
  startAt: number;
  endAt: number;
}) {
  const [value, setValue] = useState(0);

  useMotionValueEvent(scrollYProgress, 'change', (p) => {
    if (p < startAt) {
      setValue(0);
    } else if (p > endAt) {
      setValue(target);
    } else {
      const t = (p - startAt) / (endAt - startAt);
      // Ease out quad
      const eased = 1 - (1 - t) * (1 - t);
      setValue(Math.round(target * eased));
    }
  });

  const opacity = useTransform(
    scrollYProgress,
    [startAt - 0.02, startAt],
    [0, 1]
  );
  const y = useTransform(
    scrollYProgress,
    [startAt - 0.02, startAt + 0.05],
    [30, 0]
  );

  return (
    <motion.div className="text-center" style={{ opacity, y }}>
      <div className="text-[clamp(2rem,6vw,4.5rem)] font-black tracking-tight text-gradient-blue leading-none">
        {prefix}
        {value.toLocaleString()}
        {suffix}
      </div>
      <div className="text-xs md:text-sm text-white/35 font-mono tracking-wider mt-2 uppercase">
        {label}
      </div>
    </motion.div>
  );
}

// ─── Concentric scale rings ────────────────────────────────────────────────
function ScaleRings({
  scrollYProgress,
}: {
  scrollYProgress: MotionValue<number>;
}) {
  const ringCount = 5;
  const rings = useMemo(
    () => Array.from({ length: ringCount }, (_, i) => i),
    []
  );

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      {rings.map((i) => {
        const start = 0.18 + i * 0.03;
        const end = start + 0.15;
        const scale = useTransform(scrollYProgress, [start, end], [0, 1]);
        const opacity = useTransform(
          scrollYProgress,
          [start, start + 0.05, end - 0.02, end],
          [0, 0.15 - i * 0.02, 0.15 - i * 0.02, 0]
        );
        const size = 200 + i * 140;

        return (
          <motion.div
            key={i}
            className="absolute rounded-full border"
            style={{
              width: size,
              height: size,
              scale,
              opacity,
              borderColor:
                i % 2 === 0
                  ? 'rgba(41,121,255,0.3)'
                  : 'rgba(124,58,237,0.2)',
            }}
          />
        );
      })}
    </div>
  );
}

// ─── Deploy code block (types itself) ──────────────────────────────────────
function DeployBlock({
  scrollYProgress,
}: {
  scrollYProgress: MotionValue<number>;
}) {
  const lines = [
    { text: '# Deploy PeerGrid in 60 seconds', color: 'text-white/25' },
    { text: '', color: '' },
    { text: 'git clone https://github.com/peergrid/engine', color: 'text-white/70' },
    { text: 'cd engine', color: 'text-white/70' },
    { text: 'docker compose -f docker-compose.prod.yml up -d', color: 'text-accent-emerald' },
    { text: '', color: '' },
    { text: '# ✓ PeerGrid running on :4850', color: 'text-accent-emerald/70' },
  ];

  const blockOpacity = useTransform(scrollYProgress, [0.38, 0.42], [0, 1]);
  const blockY = useTransform(scrollYProgress, [0.38, 0.45], [40, 0]);
  const blockScale = useTransform(scrollYProgress, [0.38, 0.45], [0.95, 1]);

  return (
    <motion.div
      className="w-full max-w-xl mx-auto"
      style={{ opacity: blockOpacity, y: blockY, scale: blockScale }}
    >
      <div className="code-block">
        <div className="flex items-center gap-2 mb-4 pb-3 border-b border-white/[0.06]">
          <div className="w-2.5 h-2.5 rounded-full bg-red-500/50" />
          <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50" />
          <div className="w-2.5 h-2.5 rounded-full bg-green-500/50" />
          <span className="ml-2 text-[10px] text-white/20 font-mono">terminal</span>
        </div>
        {lines.map((line, i) => {
          const lineStart = 0.42 + (i / lines.length) * 0.15;
          return (
            <DeployLine
              key={i}
              text={line.text}
              color={line.color}
              revealAt={lineStart}
              scrollYProgress={scrollYProgress}
              showPrompt={line.text.length > 0 && !line.text.startsWith('#')}
            />
          );
        })}
      </div>
    </motion.div>
  );
}

function DeployLine({
  text,
  color,
  revealAt,
  scrollYProgress,
  showPrompt,
}: {
  text: string;
  color: string;
  revealAt: number;
  scrollYProgress: MotionValue<number>;
  showPrompt: boolean;
}) {
  const opacity = useTransform(
    scrollYProgress,
    [revealAt - 0.005, revealAt],
    [0, 1]
  );

  if (!text) return <div className="h-5" />;

  return (
    <motion.div
      className={`font-mono text-xs md:text-sm leading-7 ${color}`}
      style={{ opacity }}
    >
      {showPrompt && <span className="text-accent-blue mr-2">$</span>}
      {text}
    </motion.div>
  );
}

// ─── CTA Area ──────────────────────────────────────────────────────────────
function CTAArea({
  scrollYProgress,
}: {
  scrollYProgress: MotionValue<number>;
}) {
  const opacity = useTransform(scrollYProgress, [0.62, 0.7], [0, 1]);
  const y = useTransform(scrollYProgress, [0.62, 0.7], [40, 0]);

  return (
    <motion.div
      className="text-center"
      style={{ opacity, y }}
    >
      <div className="flex flex-wrap items-center justify-center gap-4">
        <button className="btn-primary text-base px-10 py-4">
          Book Product Demo
        </button>
        <a
          href="https://github.com/vaibhav-tadikamalla/PeerGridBackendReady"
          target="_blank"
          rel="noreferrer"
          className="btn-ghost text-base px-8 py-4"
        >
          Open Technical Due Diligence →
        </a>
      </div>
      <p className="mt-4 text-xs md:text-sm text-white/45 font-mono tracking-wide">
        Built for enterprise pilots and production reliability reviews.
      </p>
    </motion.div>
  );
}

// ─── Main Act ──────────────────────────────────────────────────────────────
export default function Act5_Finale() {
  const containerRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  });

  // ── Section label ──
  const labelOpacity = useTransform(scrollYProgress, [0.0, 0.06], [0, 1]);

  // ── "Designed for scale" narrative (0.28–0.38) ──
  const scaleNarrativeOpacity = useTransform(
    scrollYProgress,
    [0.28, 0.34, 0.36, 0.40],
    [0, 1, 1, 0]
  );
  const scaleNarrativeY = useTransform(scrollYProgress, [0.28, 0.34], [25, 0]);

  // ── Tech stack badges (0.68–0.82) ──
  const techOpacity = useTransform(
    scrollYProgress,
    [0.68, 0.74, 0.80, 0.84],
    [0, 1, 1, 0]
  );

  // ── Final tagline ──
  const taglineOpacity = useTransform(scrollYProgress, [0.80, 0.88], [0, 1]);
  const taglineY = useTransform(scrollYProgress, [0.80, 0.88], [20, 0]);

  // ── Closing message (fills 0.88–1.0) ──
  const closingOpacity = useTransform(
    scrollYProgress,
    [0.88, 0.94, 0.97, 1],
    [0, 1, 1, 0]
  );
  const closingY = useTransform(scrollYProgress, [0.88, 0.94], [15, 0]);

  return (
    <section
      ref={containerRef}
      className="relative bg-void"
      style={{ height: '400vh' }}
    >
      <div className="act-viewport flex-col gap-12">
        {/* Background glow */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 60% 50% at 50% 40%, rgba(41,121,255,0.05) 0%, transparent 60%)',
          }}
        />

        {/* Scale rings */}
        <ScaleRings scrollYProgress={scrollYProgress} />

        {/* Section label */}
        <motion.div
          className="absolute top-16 left-1/2 -translate-x-1/2 z-10"
          style={{ opacity: labelOpacity }}
        >
          <span className="text-[10px] font-mono tracking-[0.4em] uppercase text-accent-violet/60">
            Built for Scale
          </span>
        </motion.div>

        {/* Content stack */}
        <div className="relative z-10 w-full max-w-4xl px-8 flex flex-col items-center gap-12">
          {/* Counters */}
          <div className="grid grid-cols-3 gap-8 md:gap-16 w-full max-w-3xl">
            <AnimatedCounter
              target={3000000}
              suffix=""
              label="Ops per second"
              scrollYProgress={scrollYProgress}
              startAt={0.05}
              endAt={0.22}
            />
            <AnimatedCounter
              target={99}
              suffix=".99%"
              label="Uptime SLA"
              scrollYProgress={scrollYProgress}
              startAt={0.08}
              endAt={0.25}
            />
            <AnimatedCounter
              prefix="<"
              target={2}
              suffix="ms"
              label="P50 Latency"
              scrollYProgress={scrollYProgress}
              startAt={0.11}
              endAt={0.28}
            />
          </div>

          {/* Deploy block */}
          <DeployBlock scrollYProgress={scrollYProgress} />

          {/* CTA */}
          <CTAArea scrollYProgress={scrollYProgress} />
        </div>

        {/* "Designed for scale" narrative text */}
        <motion.div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 text-center max-w-lg px-8 pointer-events-none"
          style={{ opacity: scaleNarrativeOpacity, y: scaleNarrativeY }}
        >
          <p className="text-sm md:text-base font-light text-white/50 italic tracking-wide leading-relaxed">
            From one node to millions. PeerGrid scales horizontally —
            no sharding headaches, no coordination bottlenecks.
          </p>
        </motion.div>

        {/* Tech stack / integration badges */}
        <motion.div
          className="absolute bottom-36 left-1/2 -translate-x-1/2 z-10 pointer-events-none"
          style={{ opacity: techOpacity }}
        >
          <div className="text-center mb-3">
            <span className="text-[10px] font-mono tracking-[0.3em] uppercase text-white/25">
              Works with your stack
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {[
              'React', 'Vue', 'Svelte', 'Node.js', 'Deno', 'Docker', 'K8s', 'gRPC',
            ].map((tech) => (
              <div
                key={tech}
                className="px-4 py-1.5 rounded-full border border-white/[0.06] bg-white/[0.02]
                           text-[11px] font-mono text-white/40"
              >
                {tech}
              </div>
            ))}
          </div>
        </motion.div>

        {/* Final tagline */}
        <motion.div
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10 text-center"
          style={{ opacity: taglineOpacity, y: taglineY }}
        >
          <p className="text-white/25 text-sm font-mono tracking-widest">
            The collaboration engine for the next decade.
          </p>
        </motion.div>

        {/* Closing message (fills 0.88–1.0) */}
        <motion.div
          className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 text-center pointer-events-none"
          style={{ opacity: closingOpacity, y: closingY }}
        >
          <p className="text-xs font-mono text-white/15 tracking-wider">
            Stop waiting. Start building. ↓
          </p>
        </motion.div>
      </div>
    </section>
  );
}
