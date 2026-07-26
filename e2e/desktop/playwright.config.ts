import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const configDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Desktop e2e baseline (audit P2-6).
 *
 * Standalone config — intentionally NOT merged into the root
 * playwright.config.ts (which owns the mobile bridge e2e suite). Runs the
 * desktop Vite page in Chromium with a fake `__TAURI_INTERNALS__`
 * injected per-test (see ./fakeTauri.ts); real WebView2/WKWebView rendering
 * differences stay covered by the manual dual-platform checklist.
 */
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  reporter: [['list']],
  globalSetup: './globalSetup.ts',
  use: {
    baseURL: 'http://127.0.0.1:5176',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 5176 --strictPort',
    url: 'http://127.0.0.1:5176',
    reuseExistingServer: false,
    timeout: 120_000,
    // webServer cwd defaults to this config's directory — point Vite at the
    // repo root where index.html lives.
    cwd: path.resolve(configDir, '../..'),
    // Vite's dev server exits as soon as its (non-TTY) stdin closes — which
    // is exactly how Playwright spawns webServer commands. `CI=true` is the
    // documented escape hatch: Vite skips the stdin "end" shutdown hook.
    env: { CI: 'true' },
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        browserName: 'chromium',
      },
    },
  ],
});
