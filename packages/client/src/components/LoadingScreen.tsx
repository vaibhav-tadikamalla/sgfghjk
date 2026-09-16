import React from 'react';
import { motion } from 'framer-motion';

export function LoadingScreen() {
  return (
    <div className="fixed inset-0 bg-surface-0 flex items-center justify-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="flex flex-col items-center gap-6"
      >
        <div className="relative w-12 h-12">
          <motion.div
            className="absolute inset-0 rounded-2xl bg-accent"
            animate={{ rotate: 360 }}
            transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
            style={{ borderRadius: '30% 70% 70% 30% / 30% 30% 70% 70%' }}
          />
        </div>
        <motion.p
          className="text-sm text-text-muted"
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 2, repeat: Infinity }}
        >
          Loading…
        </motion.p>
      </motion.div>
    </div>
  );
}
