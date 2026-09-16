/**
 * Act 3: Collaboration
 *
 * Two editor panels slide in, both showing the same document.
 * Cursors type simultaneously. A convergence proof section fills
 * the middle gap. Statistics reveal at the end.
 *
 * Scroll phases (evenly distributed, no dead zones):
 *   0.00–0.04  Section label fades in
 *   0.04–0.16  Editor A slides in from left
 *   0.10–0.22  Editor B slides in from right
 *   0.14–0.20  Connection indicator
 *   0.20–0.44  Alice types (3 lines)
 *   0.30–0.54  Bob types (3 lines)
 *   0.54–0.66  "Convergence proof" text + merge animation
 *   0.66–0.76  Editors scale down, CRDT explanation callouts
 *   0.76–0.90  Stats reveal (4 cards staggered)
 *   0.90–1.00  Summary text + fade
 */

import { useRef } from 'react';
import { motion, useScroll, useTransform, MotionValue } from 'framer-motion';

// ─── Simulated document lines ──────────────────────────────────────────────
const DOC_LINES = [
  'import { PeerGrid } from "@peergrid/sdk";',
  '',
  'const doc = PeerGrid.createDocument({',
  '  name: "design-spec.md",',
  '  replication: "crdt",',
  '  consistency: "eventual",',
  '});',
  '',
  'doc.on("change", (ops) => {',
  '  console.log(`${ops.length} operations merged`);',
  '});',
];

const ALICE_LINES = [
  '// Alice is editing from San Francisco',
  'doc.insert(0, "# Project Roadmap\\n");',
  'doc.insert(1, "## Q3 Milestones\\n");',
];

const BOB_LINES = [
  '// Bob is editing from Tokyo',
  'doc.insert(3, "## Architecture\\n");',
  'doc.insert(4, "- CRDT-based sync engine\\n");',
];

// ─── Code line component ───────────────────────────────────────────────────
function CodeLine({
  text,
  lineIndex,
  startProgress,
  endProgress,
  scrollYProgress,
}: {
  text: string;
  lineIndex: number;
  startProgress: number;
  endProgress: number;
  scrollYProgress: MotionValue<number>;
  cursorColor?: string;
}) {
  const chars = text.split('');
  const lineOpacity = useTransform(
    scrollYProgress,
    [startProgress - 0.01, startProgress],
    [0, 1]
  );

  return (
    <motion.div
      className="font-mono text-xs md:text-sm leading-6 whitespace-pre"
      style={{ opacity: lineOpacity }}
    >
      <span className="text-white/20 select-none mr-4 inline-block w-6 text-right">
        {lineIndex + 1}
      </span>
      {chars.map((char, i) => {
        const charStart =
          startProgress + (i / chars.length) * (endProgress - startProgress);
        return (
          <CharReveal
            key={i}
            char={char}
            revealAt={charStart}
            scrollYProgress={scrollYProgress}
          />
        );
      })}
    </motion.div>
  );
}

function CharReveal({
  char,
  revealAt,
  scrollYProgress,
}: {
  char: string;
  revealAt: number;
  scrollYProgress: MotionValue<number>;
}) {
  const opacity = useTransform(
    scrollYProgress,
    [revealAt - 0.003, revealAt],
    [0, 1]
  );

  let color = 'text-white/80';
  if (char === '{' || char === '}' || char === '(' || char === ')' || char === ';')
    color = 'text-white/40';

  return (
    <motion.span className={`inline ${color}`} style={{ opacity }}>
      {char}
    </motion.span>
  );
}

// ─── Editor Panel ──────────────────────────────────────────────────────────
function EditorPanel({
  subtitle,
  lines,
  scrollYProgress,
  typeStart,
  typeEnd,
  slideFrom,
  slideProgress,
  cursorColor,
  avatarEmoji,
}: {
  subtitle: string;
  lines: string[];
  scrollYProgress: MotionValue<number>;
  typeStart: number;
  typeEnd: number;
  slideFrom: 'left' | 'right';
  slideProgress: [number, number];
  cursorColor: string;
  avatarEmoji: string;
}) {
  const x = useTransform(
    scrollYProgress,
    slideProgress,
    [slideFrom === 'left' ? -120 : 120, 0]
  );
  const opacity = useTransform(scrollYProgress, slideProgress, [0, 1]);

  return (
    <motion.div
      className="editor-panel w-full max-w-lg"
      style={{ x, opacity }}
    >
      <div className="editor-titlebar">
        <div className="editor-dot bg-red-500/60" />
        <div className="editor-dot bg-yellow-500/60" />
        <div className="editor-dot bg-green-500/60" />
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-white/30">{subtitle}</span>
          <span className="text-xs">{avatarEmoji}</span>
        </div>
      </div>

      <div className="p-4 min-h-[200px] md:min-h-[260px]">
        {DOC_LINES.map((line, i) => (
          <div
            key={`base-${i}`}
            className="font-mono text-xs md:text-sm leading-6 whitespace-pre text-white/50"
          >
            <span className="text-white/20 select-none mr-4 inline-block w-6 text-right">
              {i + 1}
            </span>
            {line || '\u00A0'}
          </div>
        ))}

        <div className="mt-2 border-l-2 pl-3" style={{ borderColor: cursorColor }}>
          {lines.map((line, i) => (
            <CodeLine
              key={i}
              text={line}
              lineIndex={DOC_LINES.length + i}
              startProgress={typeStart + (i / lines.length) * (typeEnd - typeStart)}
              endProgress={typeStart + ((i + 1) / lines.length) * (typeEnd - typeStart)}
              scrollYProgress={scrollYProgress}
              cursorColor={cursorColor}
            />
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// ─── Stat Card ─────────────────────────────────────────────────────────────
function StatCard({
  value,
  label,
  icon,
  scrollYProgress,
  showAt,
}: {
  value: string;
  label: string;
  icon: string;
  scrollYProgress: MotionValue<number>;
  showAt: number;
}) {
  const opacity = useTransform(
    scrollYProgress,
    [showAt, showAt + 0.04, 0.94, 1],
    [0, 1, 1, 0]
  );
  const y = useTransform(scrollYProgress, [showAt, showAt + 0.04], [30, 0]);
  const scale = useTransform(scrollYProgress, [showAt, showAt + 0.04], [0.9, 1]);

  return (
    <motion.div className="text-center" style={{ opacity, y, scale }}>
      <div className="text-2xl mb-1">{icon}</div>
      <div className="text-2xl md:text-3xl font-black text-gradient-blue">{value}</div>
      <div className="text-xs text-white/40 font-mono tracking-wide mt-1">{label}</div>
    </motion.div>
  );
}

// ─── Main Act ──────────────────────────────────────────────────────────────
export default function Act3_Sync() {
  const containerRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  });

  // Section title
  const titleOpacity = useTransform(scrollYProgress, [0.0, 0.06, 0.14, 0.18], [0, 1, 1, 0.6]);
  const titleY = useTransform(scrollYProgress, [0.0, 0.06], [40, 0]);

  // Editors container
  const editorsOpacity = useTransform(
    scrollYProgress,
    [0, 0.04, 0.62, 0.68],
    [0, 1, 1, 0]
  );
  const editorsScale = useTransform(
    scrollYProgress,
    [0.62, 0.68],
    [1, 0.88]
  );

  // Convergence proof (fills the gap between typing and stats)
  const convergenceOpacity = useTransform(
    scrollYProgress,
    [0.54, 0.60, 0.72, 0.76],
    [0, 1, 1, 0]
  );
  const convergenceY = useTransform(scrollYProgress, [0.54, 0.60], [40, 0]);

  // CRDT explanation
  const crdtOpacity = useTransform(
    scrollYProgress,
    [0.60, 0.66, 0.72, 0.76],
    [0, 1, 1, 0]
  );

  // Stats area
  const statsOpacity = useTransform(scrollYProgress, [0.74, 0.78], [0, 1]);

  // Summary text
  const summaryOpacity = useTransform(scrollYProgress, [0.88, 0.94, 0.96, 1], [0, 1, 1, 0]);
  const summaryY = useTransform(scrollYProgress, [0.88, 0.94], [20, 0]);

  return (
    <section
      ref={containerRef}
      className="relative bg-void"
      style={{ height: '450vh' }}
    >
      <div className="act-viewport flex-col">
        {/* Ambient background */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 80% 50% at 50% 60%, rgba(41,121,255,0.04) 0%, transparent 70%)',
          }}
        />

        {/* Section label */}
        <motion.div
          className="absolute top-16 left-1/2 -translate-x-1/2 z-10"
          style={{ opacity: titleOpacity, y: titleY }}
        >
          <span className="text-[10px] font-mono tracking-[0.4em] uppercase text-accent-blue/60">
            Real-Time Sync
          </span>
        </motion.div>

        {/* Editor panels */}
        <motion.div
          className="flex flex-col lg:flex-row items-center justify-center gap-6 px-6 w-full max-w-6xl"
          style={{ opacity: editorsOpacity, scale: editorsScale }}
        >
          <EditorPanel
            subtitle="SF, USA · 2ms"
            lines={ALICE_LINES}
            scrollYProgress={scrollYProgress}
            typeStart={0.20}
            typeEnd={0.44}
            slideFrom="left"
            slideProgress={[0.04, 0.16]}
            cursorColor="#2979FF"
            avatarEmoji="👩‍💻"
          />

          {/* Connection indicator */}
          <motion.div
            className="flex flex-col items-center gap-2"
            style={{
              opacity: useTransform(scrollYProgress, [0.14, 0.22], [0, 1]),
            }}
          >
            <div className="w-8 h-8 rounded-full bg-accent-emerald/20 border border-accent-emerald/30 flex items-center justify-center">
              <span className="text-accent-emerald text-xs">⚡</span>
            </div>
            <span className="text-[9px] font-mono text-white/25 tracking-widest">SYNCED</span>
          </motion.div>

          <EditorPanel
            subtitle="Tokyo, JP · 48ms"
            lines={BOB_LINES}
            scrollYProgress={scrollYProgress}
            typeStart={0.30}
            typeEnd={0.54}
            slideFrom="right"
            slideProgress={[0.10, 0.22]}
            cursorColor="#7C3AED"
            avatarEmoji="👨‍💻"
          />
        </motion.div>

        {/* ── Convergence proof section (fills dead zone 0.54-0.76) ── */}
        <motion.div
          className="absolute inset-0 flex flex-col items-center justify-center z-20 pointer-events-none"
          style={{ opacity: convergenceOpacity, y: convergenceY }}
        >
          <div className="text-center max-w-lg px-8">
            <h3 className="text-[clamp(1.5rem,4vw,2.5rem)] font-black tracking-tight text-white/90">
              Convergence <span className="text-gradient-full">Guaranteed</span>
            </h3>
            <p className="mt-3 text-sm text-white/40 leading-relaxed">
              Both editors see the same final document — always. No matter the
              network latency, no matter the edit order.
            </p>
          </div>
        </motion.div>

        {/* CRDT explanation pills */}
        <motion.div
          className="absolute bottom-36 left-1/2 -translate-x-1/2 z-20 pointer-events-none"
          style={{ opacity: crdtOpacity }}
        >
          <div className="flex flex-wrap items-center justify-center gap-3">
            {[
              { icon: '⇆', text: 'Commutative ops' },
              { icon: '⊕', text: 'Associative merges' },
              { icon: '∅', text: 'Idempotent delivery' },
            ].map((item, i) => (
              <div
                key={i}
                className="flex items-center gap-2 px-4 py-2 rounded-full
                           border border-white/[0.06] bg-white/[0.02] text-xs font-mono text-white/50"
              >
                <span className="text-accent-blue">{item.icon}</span>
                {item.text}
              </div>
            ))}
          </div>
        </motion.div>

        {/* Stats reveal */}
        <motion.div
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10 w-full max-w-2xl px-8"
          style={{ opacity: statsOpacity }}
        >
          <div className="flex items-center justify-around">
            <StatCard value="< 2ms" label="Local Latency" icon="⚡" scrollYProgress={scrollYProgress} showAt={0.76} />
            <StatCard value="0" label="Conflicts" icon="✓" scrollYProgress={scrollYProgress} showAt={0.79} />
            <StatCard value="∞" label="Convergence" icon="∮" scrollYProgress={scrollYProgress} showAt={0.82} />
            <StatCard value="E2EE" label="Encrypted" icon="🔒" scrollYProgress={scrollYProgress} showAt={0.85} />
          </div>
        </motion.div>

        {/* Summary text */}
        <motion.div
          className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10 text-center pointer-events-none"
          style={{ opacity: summaryOpacity, y: summaryY }}
        >
          <p className="text-xs font-mono text-white/20 tracking-widest">
            Zero conflicts. Zero coordination overhead. Just flow.
          </p>
        </motion.div>
      </div>
    </section>
  );
}
