import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The console talks to the Veritrail server (default :8787). In dev, proxy
// `/api/*` to it so the SPA and API share an origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.VERITRAIL_API ?? 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5173,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.VERITRAIL_API ?? 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'cloudscape-core': ['@cloudscape-design/components', '@cloudscape-design/global-styles'],
          'react-vendor': ['react', 'react-dom'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
