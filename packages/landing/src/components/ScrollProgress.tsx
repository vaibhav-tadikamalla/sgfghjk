/**
 * ScrollProgress — a thin vertical line on the left edge of the viewport
 * that fills with a gradient as the user scrolls down the page.
 */

import { motion, useScroll, useTransform } from 'framer-motion';

export default function ScrollProgress() {
  const { scrollYProgress } = useScroll();

  const scaleY = useTransform(scrollYProgress, [0, 1], [0, 1]);

  return (
    <div className="scroll-progress-bar">
      <motion.div
        className="fill"
        style={{ scaleY, height: '100%' }}
      />
    </div>
  );
}
