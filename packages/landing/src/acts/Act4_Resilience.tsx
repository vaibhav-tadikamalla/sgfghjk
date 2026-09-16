/**
 * Act 4: Resilience
 *
 * The calm network is hit by chaos — nodes die, connections sever, the system
 * self-heals. A full-viewport R3F scene driven by scroll progress.
 *
 * Scroll phases (enriched, no dead zones):
 *   0.00–0.03  Fade in
 *   0.02–0.14  Calm: narrative text + "Network Stable" label
 *   0.08–0.16  Calm callout: uptime / health
 *   0.15–0.55  Chaos phase — red vignette, nodes die, shockwave
 *   0.18–0.28  Chaos event log (left side)
 *   0.30–0.58  Peak chaos stats (bottom)
 *   0.42–0.54  Chaos callout: "what's happening" (right side)
 *   0.58–0.86  Healing: green vignette, nodes resurrect
 *   0.62–0.72  Heal callout: quorum / replication (left side)
 *   0.72–0.82  Heal callout: consistency restored (right side)
 *   0.78–0.92  Final text: "Break anything. Lose nothing."
 *   0.88–0.98  Before/after comparison bar
 *   0.94–1.00  Fade out
 */

import { useRef } from 'react';
import { motion, useScroll, useTransform, MotionValue } from 'framer-motion';
import NetworkCanvas from '@/scenes/NetworkCanvas';

// ─── Side callout ──────────────────────────────────────────────────────────
function SideCallout({
  title,
  description,
  side,
  showAt,
  hideAt,
  color = 'accent-blue',
  scrollYProgress,
}: {
  title: string;
  description: string;
  side: 'left' | 'right';
  showAt: number;
  hideAt: number;
  color?: string;
  scrollYProgress: MotionValue<number>;
}) {
  const opacity = useTransform(
    scrollYProgress,
    [showAt, showAt + 0.04, hideAt - 0.03, hideAt],
    [0, 1, 1, 0]
  );
  const y = useTransform(scrollYProgress, [showAt, showAt + 0.05], [15, 0]);

  return (
    <motion.div
      className={`absolute ${side === 'left' ? 'left-6 md:left-14' : 'right-6 md:right-14'} top-1/2 -translate-y-1/2 z-10 pointer-events-none max-w-[220px]`}
      style={{ opacity, y }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <div className={`w-1.5 h-1.5 rounded-full bg-${color} animate-pulse`} />
        <span className={`text-xs font-mono text-${color}/80 tracking-wider uppercase`}>
          {title}
        </span>
      </div>
      <p className="text-[11px] text-white/35 font-mono pl-3.5 leading-relaxed">
        {description}
      </p>
    </motion.div>
  );
}

export default function Act4_Resilience() {
  const containerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(0);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  });

  scrollYProgress.on('change', (v) => {
    progressRef.current = v;
  });

  // ── Phase indicator labels ──
  const calmOpacity = useTransform(
    scrollYProgress,
    [0.02, 0.08, 0.12, 0.16],
    [0, 1, 1, 0]
  );
  const chaosOpacity = useTransform(
    scrollYProgress,
    [0.18, 0.25, 0.5, 0.55],
    [0, 1, 1, 0]
  );
  const healOpacity = useTransform(
    scrollYProgress,
    [0.58, 0.65, 0.82, 0.86],
    [0, 1, 1, 0]
  );

  // ── Red vignette during chaos ──
  const vignetteOpacity = useTransform(
    scrollYProgress,
    [0.15, 0.35, 0.55, 0.65],
    [0, 0.25, 0.25, 0]
  );

  // ── Green vignette during healing ──
  const healVignetteOpacity = useTransform(
    scrollYProgress,
    [0.6, 0.7, 0.85, 0.92],
    [0, 0.15, 0.15, 0]
  );

  // ── Calm narrative text ──
  const calmTextOpacity = useTransform(
    scrollYProgress,
    [0.02, 0.06, 0.10, 0.14],
    [0, 1, 1, 0]
  );
  const calmTextY = useTransform(scrollYProgress, [0.02, 0.06], [20, 0]);

  // ── Chaos event log (timeline) ──
  const eventLogOpacity = useTransform(
    scrollYProgress,
    [0.18, 0.24, 0.46, 0.52],
    [0, 1, 1, 0]
  );

  // ── Final text reveal ──
  const textOpacity = useTransform(scrollYProgress, [0.78, 0.86], [0, 1]);
  const textY = useTransform(scrollYProgress, [0.78, 0.86], [30, 0]);

  // ── Before/after comparison ──
  const comparisonOpacity = useTransform(
    scrollYProgress,
    [0.88, 0.94, 0.96, 1],
    [0, 1, 1, 0]
  );
  const comparisonY = useTransform(scrollYProgress, [0.88, 0.94], [20, 0]);

  // ── Act entry/exit ──
  const actOpacity = useTransform(
    scrollYProgress,
    [0, 0.03, 0.94, 1],
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
          {/* R3F Network (chaos mode) */}
          <NetworkCanvas progress={progressRef} mode="chaos" />

          {/* Red chaos vignette */}
          <motion.div
            className="absolute inset-0 pointer-events-none"
            style={{
              opacity: vignetteOpacity,
              background:
                'radial-gradient(ellipse 70% 60% at 50% 50%, rgba(244,63,94,0.15) 0%, rgba(244,63,94,0.05) 40%, transparent 70%)',
              mixBlendMode: 'screen',
            }}
          />

          {/* Green heal vignette */}
          <motion.div
            className="absolute inset-0 pointer-events-none"
            style={{
              opacity: healVignetteOpacity,
              background:
                'radial-gradient(ellipse 70% 60% at 50% 50%, rgba(16,185,129,0.15) 0%, rgba(16,185,129,0.05) 40%, transparent 70%)',
              mixBlendMode: 'screen',
            }}
          />

          {/* Phase labels (top of screen) */}
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-10">
            <motion.div
              className="text-center"
              style={{ opacity: calmOpacity }}
            >
              <span className="text-[10px] font-mono tracking-[0.4em] uppercase text-accent-emerald/70">
                Network Stable
              </span>
            </motion.div>
            <motion.div
              className="text-center absolute inset-0"
              style={{ opacity: chaosOpacity }}
            >
              <span className="text-[10px] font-mono tracking-[0.4em] uppercase text-accent-rose/90">
                ⚠ Fault Injection Active
              </span>
            </motion.div>
            <motion.div
              className="text-center absolute inset-0"
              style={{ opacity: healOpacity }}
            >
              <span className="text-[10px] font-mono tracking-[0.4em] uppercase text-accent-emerald/70">
                Self-Healing In Progress
              </span>
            </motion.div>
          </div>

          {/* ── Calm phase narrative (0.02–0.14) ── */}
          <motion.div
            className="absolute bottom-28 left-1/2 -translate-x-1/2 z-10 text-center max-w-lg px-8 pointer-events-none"
            style={{ opacity: calmTextOpacity, y: calmTextY }}
          >
            <p className="text-sm md:text-base font-light text-white/50 italic tracking-wide leading-relaxed">
              A healthy network hums along — every node in sync,
              every connection alive. But what happens when things break?
            </p>
          </motion.div>

          {/* ── Calm health callout (0.08–0.16) ── */}
          <SideCallout
            title="100% Healthy"
            description="All 70 nodes online. All 120 connections stable. Replication factor: 3."
            side="right"
            showAt={0.08}
            hideAt={0.16}
            color="accent-emerald"
            scrollYProgress={scrollYProgress}
          />

          {/* ── Chaos event log (0.18–0.52) ── */}
          <motion.div
            className="absolute left-6 md:left-14 bottom-36 z-10 pointer-events-none max-w-[260px]"
            style={{ opacity: eventLogOpacity }}
          >
            <div className="space-y-2">
              {[
                { time: '00:00.000', msg: 'node-37 disconnected', color: 'text-accent-rose' },
                { time: '00:00.012', msg: 'node-42 unreachable', color: 'text-accent-rose' },
                { time: '00:00.034', msg: 'quorum rerouting…', color: 'text-yellow-400' },
                { time: '00:00.089', msg: 'partition detected', color: 'text-accent-rose' },
                { time: '00:00.120', msg: 'failover initiated', color: 'text-yellow-400' },
              ].map((evt, i) => {
                const evtStart = 0.20 + i * 0.04;
                return (
                  <motion.div
                    key={i}
                    className="flex items-baseline gap-2"
                    style={{
                      opacity: useTransform(
                        scrollYProgress,
                        [evtStart, evtStart + 0.02],
                        [0, 1]
                      ),
                    }}
                  >
                    <span className="text-[9px] font-mono text-white/20 shrink-0">
                      {evt.time}
                    </span>
                    <span className={`text-[10px] font-mono ${evt.color}`}>
                      {evt.msg}
                    </span>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>

          {/* ── Chaos callout: what's happening (0.42–0.54) ── */}
          <SideCallout
            title="Chaos engineering"
            description="Simulating real-world failures: network splits, node crashes, disk failures."
            side="right"
            showAt={0.42}
            hideAt={0.54}
            color="accent-rose"
            scrollYProgress={scrollYProgress}
          />

          {/* Chaos stats (during peak chaos) */}
          <motion.div
            className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10"
            style={{
              opacity: useTransform(
                scrollYProgress,
                [0.30, 0.38, 0.52, 0.58],
                [0, 1, 1, 0]
              ),
            }}
          >
            <div className="flex items-center gap-8 text-center">
              <div>
                <div className="text-2xl font-black text-accent-rose">30%</div>
                <div className="text-[9px] font-mono text-white/30 tracking-wider">NODES DOWN</div>
              </div>
              <div>
                <div className="text-2xl font-black text-white/90">0 bytes</div>
                <div className="text-[9px] font-mono text-white/30 tracking-wider">DATA LOST</div>
              </div>
              <div>
                <div className="text-2xl font-black text-accent-emerald">&lt; 300ms</div>
                <div className="text-[9px] font-mono text-white/30 tracking-wider">MTTR</div>
              </div>
            </div>
          </motion.div>

          {/* ── Healing callouts ── */}
          <SideCallout
            title="Quorum consensus"
            description="Surviving nodes elect new leaders. Data re-replicated across healthy peers."
            side="left"
            showAt={0.62}
            hideAt={0.72}
            color="accent-emerald"
            scrollYProgress={scrollYProgress}
          />

          <SideCallout
            title="Consistency restored"
            description="CRDT merge resolution ensures zero conflicts during partition recovery."
            side="right"
            showAt={0.72}
            hideAt={0.82}
            color="accent-emerald"
            scrollYProgress={scrollYProgress}
          />

          {/* Final text */}
          <motion.div
            className="absolute bottom-28 left-1/2 -translate-x-1/2 z-10 text-center max-w-xl px-8"
            style={{ opacity: textOpacity, y: textY }}
          >
            <h2 className="text-[clamp(1.8rem,5vw,3.5rem)] font-black tracking-tight leading-none">
              <span className="text-white">Break anything.</span>
              <br />
              <span className="text-gradient-full">Lose nothing.</span>
            </h2>
            <p className="mt-4 text-sm text-white/35 font-mono">
              Automatic failover · Quorum consensus · Zero-downtime recovery
            </p>
          </motion.div>

          {/* ── Before/after comparison bar (0.88–0.98) ── */}
          <motion.div
            className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10 w-full max-w-md px-8 pointer-events-none"
            style={{ opacity: comparisonOpacity, y: comparisonY }}
          >
            <div className="flex items-center justify-between text-center">
              <div>
                <div className="text-lg font-black text-accent-rose/80">Before</div>
                <div className="text-[10px] font-mono text-white/25 mt-1">30% nodes down</div>
                <div className="text-[10px] font-mono text-white/25">21 connections lost</div>
              </div>
              <div className="w-12 h-px bg-gradient-to-r from-accent-rose/40 to-accent-emerald/40" />
              <div>
                <div className="text-lg font-black text-accent-emerald">After</div>
                <div className="text-[10px] font-mono text-white/25 mt-1">100% recovered</div>
                <div className="text-[10px] font-mono text-white/25">0 bytes lost</div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
