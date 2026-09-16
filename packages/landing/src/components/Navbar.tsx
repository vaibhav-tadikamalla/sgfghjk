/**
 * Minimal floating navbar — just the logo mark and a CTA.
 * Appears after the user scrolls past the hero void.
 * No hamburger menus, no nav links — the scroll IS the navigation.
 */

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function Navbar() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      // Show after scrolling past ~1 viewport
      setVisible(window.scrollY > window.innerHeight * 0.8);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <AnimatePresence>
      {visible && (
        <motion.nav
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -20, opacity: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="fixed top-5 left-1/2 -translate-x-1/2 z-[9990]
                     flex items-center gap-8 px-6 py-2.5
                     bg-white/[0.04] backdrop-blur-xl border border-white/[0.06]
                     rounded-full shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
          style={{ zIndex: 200 }}
        >
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div className="w-5 h-5 rounded-md bg-gradient-to-br from-[#2979FF] to-[#7C3AED] flex items-center justify-center">
              <span className="text-[8px] font-black text-white leading-none">P</span>
            </div>
            <span className="text-sm font-bold tracking-tight text-white/90">
              PeerGrid
            </span>
          </div>

          {/* Separator */}
          <div className="w-px h-4 bg-white/10" />

          {/* CTA */}
          <a
            href="https://github.com/vaibhav-tadikamalla/PeerGridBackendReady"
            target="_blank"
            rel="noreferrer"
            className="text-xs font-semibold text-white/60 hover:text-white transition-colors"
          >
            GitHub →
          </a>
        </motion.nav>
      )}
    </AnimatePresence>
  );
}
