import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        void: '#030303',
        surface: {
          DEFAULT: '#050505',
          1: '#0A0A0A',
          2: '#111111',
          3: '#1A1A1A',
        },
        accent: {
          blue: '#2979FF',
          cyan: '#00E5FF',
          violet: '#7C3AED',
          emerald: '#10B981',
          rose: '#F43F5E',
        },
      },
      fontFamily: {
        sans: ['Inter var', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        blink: 'blink 1s step-end infinite',
        'fade-in': 'fadeIn 0.6s ease-out forwards',
        'glow-pulse': 'glowPulse 2s ease-in-out infinite alternate',
        float: 'float 6s ease-in-out infinite',
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        glowPulse: {
          from: { boxShadow: '0 0 20px rgba(41,121,255,0.3)' },
          to: { boxShadow: '0 0 60px rgba(41,121,255,0.7), 0 0 90px rgba(124,58,237,0.3)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-12px)' },
        },
      },
      blur: {
        '4xl': '80px',
      },
    },
  },
  plugins: [],
} satisfies Config;
