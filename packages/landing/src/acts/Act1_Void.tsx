/**
 * Act 1: The Void
 *
 * Pure black with starfield → blinking cursor → text types → text shatters →
 * "PEERGRID" assembles → subtitle → feature pills cascade in.
 *
 * Phases fill 0..1 with NO dead zones.
 */

import { useRef, useMemo } from 'react';
import {
  motion,
  useScroll,
  useTransform,
  MotionValue,
} from 'framer-motion';

// ─── Config ────────────────────────────────────────────────────────────────
const OPENING_TEXT = 'What if editing had no boundaries?';
const BRAND_TEXT = 'PEERGRID';
const SUBTITLE = 'Real-time. Distributed. Unstoppable.';
const FEATURE_PILLS = [
  { label: 'CRDT Engine', icon: '⚙' },
  { label: 'P2P Network', icon: '🌐' },
  { label: 'E2E Encrypted', icon: '🔒' },
  { label: 'Sub-2ms Latency', icon: '⚡' },
  { label: 'Offline-First', icon: '📡' },
  { label: 'Self-Healing', icon: '💚' },
];

// Evenly distributed scroll breakpoints (0..1) — no dead zones
const P = {
  TYPE_START: 0.02,
  TYPE_END: 0.24,
  SHATTER_START: 0.28,
  SHATTER_END: 0.38,
  BRAND_START: 0.40,
  BRAND_FULL: 0.56,
  SUB_START: 0.56,
  SUB_FULL: 0.64,
  PILLS_START: 0.65,
  PILLS_END: 0.82,
  GLOW_PEAK: 0.85,
  FADE_START: 0.88,
  FADE_END: 1.0,
} as const;

// ─── Starfield background ──────────────────────────────────────────────────
function Starfield({ scrollYProgress }: { scrollYProgress: MotionValue<number> }) {
  const stars = useMemo(() => {
    const arr: { x: number; y: number; size: number; delay: number }[] = [];
    for (let i = 0; i < 80; i++) {
      arr.push({
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: 1 + Math.random() * 2,
        delay: Math.random() * 3,
      });
    }
    return arr;
  }, []);

  const starfieldOpacity = useTransform(
    scrollYProgress,
    [0, 0.05, P.FADE_START, P.FADE_END],
    [0.3, 0.8, 0.8, 0]
  );

  return (
    <motion.div
      className="absolute inset-0 pointer-events-none overflow-hidden"
      style={{ opacity: starfieldOpacity }}
    >
      {stars.map((s, i) => (
        <div
          key={i}
          className="absolute rounded-full bg-white animate-pulse"
          style={{
            left: `${s.x}%`,
            top: `${s.y}%`,
            width: s.size,
            height: s.size,
            opacity: 0.15 + Math.random() * 0.35,
            animationDelay: `${s.delay}s`,
            animationDuration: `${2 + Math.random() * 3}s`,
          }}
        />
      ))}
    </motion.div>
  );
}

// ─── Typewriter character ──────────────────────────────────────────────────
function TypewriterChar({
  char,
  index,
  total,
  scrollYProgress,
}: {
  char: string;
  index: number;
  total: number;
  scrollYProgress: MotionValue<number>;
}) {
  const revealAt = P.TYPE_START + (index / total) * (P.TYPE_END - P.TYPE_START);
  const opacity = useTransform(scrollYProgress, [revealAt - 0.005, revealAt], [0, 1]);

  const angle = (index / total) * Math.PI * 2;
  const radius = 120 + (index % 5) * 70;
  const targetX = Math.cos(angle + index * 0.3) * radius;
  const targetY = Math.sin(angle + index * 0.3) * radius - 80;
  const targetRotate = (index % 2 === 0 ? 1 : -1) * (60 + index * 12);

  const shatterX = useTransform(scrollYProgress, [P.SHATTER_START, P.SHATTER_END], [0, targetX]);
  const shatterY = useTransform(scrollYProgress, [P.SHATTER_START, P.SHATTER_END], [0, targetY]);
  const shatterRotate = useTransform(scrollYProgress, [P.SHATTER_START, P.SHATTER_END], [0, targetRotate]);
  const shatterScale = useTransform(scrollYProgress, [P.SHATTER_START, P.SHATTER_END], [1, 0]);
  const shatterOpacity = useTransform(
    scrollYProgress,
    [P.SHATTER_START, P.SHATTER_END - 0.02, P.SHATTER_END],
    [1, 0.5, 0]
  );

  return (
    <motion.span
      className="inline-block will-change-transform"
      style={{ opacity, x: shatterX, y: shatterY, rotate: shatterRotate, scale: shatterScale }}
    >
      <motion.span style={{ opacity: shatterOpacity }}>
        {char === ' ' ? '\u00A0' : char}
      </motion.span>
    </motion.span>
  );
}

// ─── Brand letter reveal ───────────────────────────────────────────────────
function BrandLetter({
  char,
  index,
  total,
  scrollYProgress,
}: {
  char: string;
  index: number;
  total: number;
  scrollYProgress: MotionValue<number>;
}) {
  const revealStart = P.BRAND_START + (index / total) * (P.BRAND_FULL - P.BRAND_START) * 0.6;
  const revealEnd = revealStart + 0.05;

  const opacity = useTransform(scrollYProgress, [revealStart, revealEnd], [0, 1]);
  const y = useTransform(scrollYProgress, [revealStart, revealEnd], [40, 0]);
  const blur = useTransform(scrollYProgress, [revealStart, revealEnd], [12, 0]);
  const filterStr = useTransform(blur, (v) => `blur(${v}px)`);

  return (
    <motion.span
      className="inline-block will-change-transform"
      style={{ opacity, y, filter: filterStr }}
    >
      {char}
    </motion.span>
  );
}

// ─── Feature pill ──────────────────────────────────────────────────────────
function FeaturePill({
  label,
  icon,
  index,
  total,
  scrollYProgress,
}: {
  label: string;
  icon: string;
  index: number;
  total: number;
  scrollYProgress: MotionValue<number>;
}) {
  const start = P.PILLS_START + (index / total) * (P.PILLS_END - P.PILLS_START);
  const end = start + 0.04;

  const opacity = useTransform(scrollYProgress, [start, end, P.FADE_START, P.FADE_END], [0, 1, 1, 0]);
  const y = useTransform(scrollYProgress, [start, end], [20, 0]);
  const scale = useTransform(scrollYProgress, [start, end], [0.85, 1]);

  return (
    <motion.div
      className="px-4 py-2 rounded-full border border-white/[0.08] bg-white/[0.03] backdrop-blur-sm
                 text-xs font-mono text-white/60 flex items-center gap-2"
      style={{ opacity, y, scale }}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </motion.div>
  );
}

// ─── Main Act ──────────────────────────────────────────────────────────────
export default function Act1_Void() {
  const containerRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  });

  const cursorOpacity = useTransform(
    scrollYProgress,
    [0, 0.01, P.TYPE_END, P.SHATTER_START],
    [1, 1, 1, 0]
  );

  const brandOpacity = useTransform(
    scrollYProgress,
    [P.BRAND_START - 0.02, P.BRAND_START, P.FADE_START, P.FADE_END],
    [0, 1, 1, 0]
  );

  const subOpacity = useTransform(
    scrollYProgress,
    [P.SUB_START, P.SUB_FULL, P.FADE_START, P.FADE_END],
    [0, 1, 1, 0]
  );
  const subY = useTransform(scrollYProgress, [P.SUB_START, P.SUB_FULL], [20, 0]);

  const hintOpacity = useTransform(
    scrollYProgress,
    [0, 0.01, 0.08, 0.14],
    [0.6, 0.6, 0.3, 0]
  );

  const glowOpacity = useTransform(
    scrollYProgress,
    [0, 0.2, P.BRAND_FULL, P.GLOW_PEAK, P.FADE_END],
    [0.02, 0.06, 0.2, 0.25, 0]
  );

  const lineOpacity = useTransform(
    scrollYProgress,
    [P.BRAND_START, P.BRAND_FULL, P.FADE_START, P.FADE_END],
    [0, 0.15, 0.15, 0]
  );
  const lineWidth = useTransform(
    scrollYProgress,
    [P.BRAND_START, P.BRAND_FULL],
    ['0%', '30%']
  );

  const chars = useMemo(() => OPENING_TEXT.split(''), []);
  const brandChars = useMemo(() => BRAND_TEXT.split(''), []);

  return (
    <section
      ref={containerRef}
      className="relative bg-void"
      style={{ height: '400vh' }}
    >
      <div className="act-viewport">
        {/* Starfield */}
        <Starfield scrollYProgress={scrollYProgress} />

        {/* Background glow */}
        <motion.div
          className="absolute inset-0 pointer-events-none"
          style={{
            opacity: glowOpacity,
            background:
              'radial-gradient(ellipse 60% 40% at 50% 50%, rgba(41,121,255,0.3) 0%, transparent 70%)',
          }}
        />

        {/* Opening text with typewriter effect */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center px-8">
            <div
              className="text-[clamp(1.2rem,3vw,2.2rem)] font-light tracking-wide text-white/90"
              style={{ perspective: '800px' }}
            >
              {chars.map((char, i) => (
                <TypewriterChar
                  key={i}
                  char={char}
                  index={i}
                  total={chars.length}
                  scrollYProgress={scrollYProgress}
                />
              ))}
              <motion.span
                className="typing-cursor ml-1"
                style={{ opacity: cursorOpacity }}
              />
            </div>
          </div>
        </div>

        {/* Brand reveal + subtitle + pills */}
        <motion.div
          className="absolute inset-0 flex flex-col items-center justify-center gap-4"
          style={{ opacity: brandOpacity }}
        >
          {/* Decorative line above */}
          <motion.div
            className="h-px bg-gradient-to-r from-transparent via-accent-blue/40 to-transparent"
            style={{ opacity: lineOpacity, width: lineWidth }}
          />

          {/* PEERGRID */}
          <h1
            className="text-[clamp(3rem,12vw,10rem)] font-black tracking-tighter leading-none text-gradient-full"
            style={{ perspective: '1000px' }}
          >
            {brandChars.map((char, i) => (
              <BrandLetter
                key={i}
                char={char}
                index={i}
                total={brandChars.length}
                scrollYProgress={scrollYProgress}
              />
            ))}
          </h1>

          {/* Decorative line below */}
          <motion.div
            className="h-px bg-gradient-to-r from-transparent via-accent-violet/30 to-transparent"
            style={{ opacity: lineOpacity, width: lineWidth }}
          />

          {/* Subtitle */}
          <motion.p
            className="mt-2 text-[clamp(0.9rem,2vw,1.4rem)] font-light tracking-widest uppercase text-white/50"
            style={{ opacity: subOpacity, y: subY }}
          >
            {SUBTITLE}
          </motion.p>

          {/* Feature pills */}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3 max-w-xl px-6">
            {FEATURE_PILLS.map((pill, i) => (
              <FeaturePill
                key={i}
                label={pill.label}
                icon={pill.icon}
                index={i}
                total={FEATURE_PILLS.length}
                scrollYProgress={scrollYProgress}
              />
            ))}
          </div>
        </motion.div>

        {/* Scroll indicator */}
        <motion.div
          className="absolute bottom-12 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3"
          style={{ opacity: hintOpacity }}
        >
          <span className="text-[10px] tracking-[0.3em] uppercase text-white/30 font-mono">
            Scroll to explore
          </span>
          <div className="w-5 h-8 rounded-full border border-white/15 flex items-start justify-center p-1.5">
            <motion.div
              className="w-1 h-1.5 rounded-full bg-white/40"
              animate={{ y: [0, 8, 0] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
            />
          </div>
        </motion.div>
      </div>
    </section>
  );
}
