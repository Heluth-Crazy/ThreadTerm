import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '');

  return {
    root: __dirname,
    plugins: [react()],
    resolve: {
      alias: {
        '@mobile': path.resolve(__dirname, './src'),
        '@shared': path.resolve(repoRoot, './src'),
      },
    },
    server: {
      host: env.HOST || '0.0.0.0',
      port: Number.parseInt(env.MOBILE_VITE_PORT || '5175', 10),
      strictPort: true,
    },
    build: {
      outDir: path.resolve(__dirname, 'dist'),
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        output: {
          entryFileNames: 'assets/index.js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name][extname]',
          manualChunks: {
            'vendor-react': ['react', 'react-dom'],
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl'],
          },
        },
      },
    },
  };
});
