import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ command, mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const host = env.HOST || '0.0.0.0'

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    // Ensure Vite clears the port for Tauri
    clearScreen: false,
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      strictPort: true,
      // Proxy removed — Tauri IPC replaces all /api and /ws calls
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      sourcemap: false,
      rollupOptions: {
        // Multi-page build — each HTML entry becomes its own bundle served
        // by Tauri. `main` is the primary window; `selector` and `float`
        // are the secondary overlay windows created on demand by
        // `src-tauri/src/overlay.rs`. `terminalHost` is a runtime-only
        // daemon surface and never enters the persisted terminal-card store.
        input: {
          main: 'index.html',
          settings: 'settings.html',
          selector: 'selector.html',
          float: 'float.html',
          terminalHost: 'terminal-host.html',
        },
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom'],
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links']
          }
        }
      }
    }
  }
})
