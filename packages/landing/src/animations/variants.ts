import { Variants } from 'framer-motion';

// ─── Easing presets ────────────────────────────────────────────────────────
export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;
export const EASE_OUT_QUART = [0.25, 1, 0.5, 1] as const;
export const EASE_IN_OUT_EXPO = [0.87, 0, 0.13, 1] as const;

// ─── Cinematic fade ────────────────────────────────────────────────────────
export const cinematicFade: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 1.2, ease: EASE_OUT_EXPO },
  },
  exit: {
    opacity: 0,
    transition: { duration: 0.6, ease: 'easeIn' },
  },
};

// ─── Word reveal (used for headline reveals) ───────────────────────────────
export const wordReveal: Variants = {
  hidden: { opacity: 0, y: 60, rotateX: 25, filter: 'blur(8px)' },
  visible: {
    opacity: 1,
    y: 0,
    rotateX: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.9, ease: EASE_OUT_EXPO },
  },
};

// ─── Character explosion (each character gets random position) ─────────────
export function makeExplosionStyle(index: number, total: number) {
  const angle = (index / total) * Math.PI * 2 + Math.random() * 0.5;
  const radius = 200 + Math.random() * 400;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius - 200,
    rotate: Math.random() * 360 - 180,
    scale: 0,
    opacity: 0,
  };
}

// ─── Stagger containers ────────────────────────────────────────────────────
export const staggerContainer: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.12, delayChildren: 0.1 },
  },
};

export const staggerFast: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.05 },
  },
};

// ─── Slide reveals ─────────────────────────────────────────────────────────
export const slideFromLeft: Variants = {
  hidden: { opacity: 0, x: -80 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.8, ease: EASE_OUT_EXPO },
  },
};

export const slideFromRight: Variants = {
  hidden: { opacity: 0, x: 80 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.8, ease: EASE_OUT_EXPO },
  },
};

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 40 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, ease: EASE_OUT_EXPO },
  },
};

// ─── Scale reveal ──────────────────────────────────────────────────────────
export const scaleReveal: Variants = {
  hidden: { opacity: 0, scale: 0.85, filter: 'blur(10px)' },
  visible: {
    opacity: 1,
    scale: 1,
    filter: 'blur(0px)',
    transition: { duration: 0.8, ease: EASE_OUT_EXPO },
  },
};

// ─── Counter number (for metrics) ──────────────────────────────────────────
export const counterPop: Variants = {
  hidden: { opacity: 0, scale: 0.5, y: 20 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { duration: 0.6, ease: EASE_OUT_EXPO },
  },
};

// ─── Line draw ─────────────────────────────────────────────────────────────
export const drawLine: Variants = {
  hidden: { pathLength: 0, opacity: 0 },
  visible: {
    pathLength: 1,
    opacity: 1,
    transition: { duration: 1.4, ease: EASE_OUT_EXPO },
  },
};
