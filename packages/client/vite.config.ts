import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@collab/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    host: '0.0.0.0',   // bind to all interfaces so phone on same WiFi can reach us
    port: 4860,
    proxy: {
      '/api': {
        target: 'http://localhost:4850',
        changeOrigin: true,
      },
      '/admin/dashboard': {
        target: 'http://localhost:4850',
        changeOrigin: true,
      },
      '/admin/simulation': {
        target: 'http://localhost:4850',
        changeOrigin: true,
      },
      '/debug': {
        target: 'http://localhost:4850',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:4850',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          yjs: ['yjs', 'lib0'],
          framer: ['framer-motion'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['yjs', 'lib0'],
  },
});
