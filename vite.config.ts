import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { injectAppCspMeta } from './desktop/src/appCsp.ts';

// The app document policy (desktop/src/appCsp.ts). Production builds get the strict policy plus the hash of the
// inline pre-paint boot script; the dev server gets the dev-only relaxation HMR needs and never ships it.
function appCsp(): Plugin {
  let dev = false;
  return {
    name: 'threadterm-app-csp',
    configResolved(config) { dev = config.command === 'serve'; },
    transformIndexHtml: { order: 'post', handler: html => injectAppCspMeta(html, { dev }) },
  };
}

export default defineConfig({
  base: './',
  root: resolve(import.meta.dirname, 'renderer'),
  plugins: [react(), appCsp()],
  css: { postcss: { plugins: [] } },
  // The sidebar preview iframe is sandboxed (opaque origin), so its module fetches arrive with Origin: null.
  // Reflecting any origin keeps those loads working in dev; this option never affects production builds.
  server: { cors: { origin: true } },
  build: {
    outDir: resolve(import.meta.dirname, 'desktop-dist/renderer'),
    emptyOutDir: true,
  },
});
