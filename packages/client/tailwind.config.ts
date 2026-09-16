import type { Config } from 'tailwindcss';

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        surface: {
          0: '#0a0a0f',
          1: '#111118',
          2: '#1a1a24',
          3: '#22222f',
          4: '#2a2a3a',
          5: '#333347',
        },
        accent: {
          DEFAULT: '#6366f1',
          hover: '#818cf8',
          muted: 'rgba(99,102,241,0.15)',
          border: 'rgba(99,102,241,0.3)',
        },
        border: {
          DEFAULT: 'rgba(255,255,255,0.08)',
          strong: 'rgba(255,255,255,0.15)',
        },
        text: {
          primary: 'rgba(255,255,255,0.92)',
          secondary: 'rgba(255,255,255,0.55)',
          muted: 'rgba(255,255,255,0.3)',
        },
      },
      backdropBlur: {
        xs: '2px',
      },
      boxShadow: {
        glass: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)',
        glow: '0 0 20px rgba(99,102,241,0.25)',
        'glow-sm': '0 0 10px rgba(99,102,241,0.2)',
      },
      animation: {
        'shimmer': 'shimmer 1.5s infinite',
        'pulse-slow': 'pulse 3s ease-in-out infinite',
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.25s cubic-bezier(0.16,1,0.3,1)',
        'slide-in-right': 'slideInRight 0.25s cubic-bezier(0.16,1,0.3,1)',
        'burst-glow': 'burstGlow 1.2s ease-in-out infinite',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        burstGlow: {
          '0%, 100%': { boxShadow: '0 0 4px rgba(239,68,68,0.3)' },
          '50%': { boxShadow: '0 0 12px rgba(239,68,68,0.6), 0 0 24px rgba(239,68,68,0.2)' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          from: { opacity: '0', transform: 'translateX(16px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
      },
      borderRadius: {
        '4xl': '2rem',
      },
    },
  },
  plugins: [],
} satisfies Config;
