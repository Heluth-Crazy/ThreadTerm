import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  root: resolve(import.meta.dirname, 'renderer'),
  plugins: [react()],
  css: { postcss: { plugins: [] } },
  // The sidebar preview iframe is sandboxed (opaque origin), so its module fetches arrive with Origin: null.
  // Reflecting any origin keeps those loads working in dev; this option never affects production builds.
  server: { cors: { origin: true } },
  build: {
    outDir: resolve(import.meta.dirname, 'desktop-dist/renderer'),
    emptyOutDir: true,
  },
});
