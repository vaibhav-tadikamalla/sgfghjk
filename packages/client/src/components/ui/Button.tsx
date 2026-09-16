import React from 'react';
import { cn } from '@/lib/utils/cn';
import { motion } from 'framer-motion';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', isLoading, children, disabled, ...props }, ref) => {
    const base =
      'inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 disabled:cursor-not-allowed no-select cursor-pointer';

    const variants = {
      primary:
        'bg-accent hover:bg-accent-hover text-white shadow-glow-sm hover:shadow-glow active:scale-95',
      ghost:
        'text-text-secondary hover:text-text-primary hover:bg-surface-3 active:bg-surface-4',
      danger:
        'bg-red-500/20 hover:bg-red-500/30 text-red-400 hover:text-red-300 border border-red-500/30',
      outline:
        'border border-border hover:border-border-strong hover:bg-surface-3 text-text-primary',
    };

    const sizes = {
      sm: 'h-7 px-3 text-xs',
      md: 'h-9 px-4 text-sm',
      lg: 'h-11 px-6 text-base',
    };

    return (
      <motion.button
        ref={ref}
        whileTap={{ scale: disabled || isLoading ? 1 : 0.96 }}
        className={cn(base, variants[variant], sizes[size], className)}
        disabled={disabled || isLoading}
        {...(props as any)}
      >
        {isLoading ? (
          <>
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span>Loading…</span>
          </>
        ) : (
          children
        )}
      </motion.button>
    );
  },
);

Button.displayName = 'Button';
