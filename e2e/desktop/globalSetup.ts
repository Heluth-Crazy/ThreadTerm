import { chromium } from '@playwright/test';
import { installFakeTauri, makeSeedCards } from './fakeTauri';

const DESKTOP_URL = 'http://127.0.0.1:5176';
const APP_READY_TIMEOUT_MS = 120_000;

export default async function globalSetup(): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await installFakeTauri(page, makeSeedCards(1));
    await page.goto(DESKTOP_URL, {
      waitUntil: 'domcontentloaded',
      timeout: APP_READY_TIMEOUT_MS,
    });
    await page.locator('#root > *').first().waitFor({
      state: 'attached',
      timeout: APP_READY_TIMEOUT_MS,
    });
  } finally {
    await browser.close();
  }
}
