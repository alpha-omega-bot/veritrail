import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The console talks to the Veritrail server (default :8787). In dev, proxy
// `/api/*` to it so the SPA and API share an origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
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
  },
});
