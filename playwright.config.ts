import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './mobile-app/e2e',
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5175',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'npm run build:mobile && npx vite preview --config mobile-app/vite.config.ts --host 127.0.0.1 --port 5175 --strictPort',
    url: 'http://127.0.0.1:5175/pair',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'android-chrome',
      use: {
        ...devices['Pixel 7'],
        browserName: 'chromium',
      },
    },
    {
      name: 'ios-safari-emulation',
      use: {
        ...devices['iPhone 14'],
        browserName: 'webkit',
      },
    },
  ],
});
