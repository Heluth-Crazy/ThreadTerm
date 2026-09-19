import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  root: resolve(import.meta.dirname, 'renderer'),
  plugins: [react()],
  css: { postcss: { plugins: [] } },
  build: {
    outDir: resolve(import.meta.dirname, 'desktop-dist/renderer'),
    emptyOutDir: true,
  },
});
