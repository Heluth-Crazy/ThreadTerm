import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'mobile-real-bridge.spec.ts',
  timeout: 30_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './globalSetup.ts',
  use: {
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'ios-webkit-real-bridge',
      use: {
        ...devices['iPhone 14'],
        browserName: 'webkit',
      },
    },
  ],
});
