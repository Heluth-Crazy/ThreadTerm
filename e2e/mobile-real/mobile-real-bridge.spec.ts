import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from '@playwright/test';

const DESCRIPTOR_ENV = 'THREADTERM_REAL_BRIDGE_DESCRIPTOR_PATH';

interface RealBridgeDescriptor {
  pairUrl: string;
  serverId: string;
  port: number;
  cardName: string;
  disconnectPath: string;
  disconnectedPath: string;
  resumePath: string;
  resumedPath: string;
  recoveredPreview: string;
}

test('mobile page pairs and receives state through the real Rust bridge', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const descriptor = readDescriptor();
  await page.goto(descriptor.pairUrl);

  await expect(page.getByRole('heading', { name: 'Workbench' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        serverId: sessionStorage.getItem('threadterm.bridgeServerId'),
        token: sessionStorage.getItem('threadterm.bridgeToken'),
      })),
    )
    .toEqual({
      serverId: descriptor.serverId,
      token: expect.any(String),
    });
  await expect(page).not.toHaveURL(/(?:\?|&)otp=/);

  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  const card = page.locator('.instance-row', { hasText: descriptor.cardName });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Real bridge browser fixture');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(`127.0.0.1:${descriptor.port}`, { exact: false }).first()).toBeVisible();

  const tokenBeforeDisconnect = await page.evaluate(() =>
    sessionStorage.getItem('threadterm.bridgeToken'),
  );
  writeFileSync(descriptor.disconnectPath, 'disconnect');
  await waitForFile(descriptor.disconnectedPath);
  await expect(page.locator('.connection-banner-reconnecting').first()).toContainText(
    'Reconnecting',
  );

  writeFileSync(descriptor.resumePath, 'resume');
  await waitForFile(descriptor.resumedPath);
  await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem('threadterm.bridgeToken')),
  ).toBe(tokenBeforeDisconnect);

  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(card).toContainText(descriptor.recoveredPreview);
  expect(pageErrors).toEqual([]);
});

function readDescriptor(): RealBridgeDescriptor {
  const descriptorPath = process.env[DESCRIPTOR_ENV];
  if (!descriptorPath) {
    throw new Error(`${DESCRIPTOR_ENV} was not set by the real bridge global setup`);
  }
  return JSON.parse(readFileSync(descriptorPath, 'utf8')) as RealBridgeDescriptor;
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for real bridge fixture signal: ${filePath}`);
}
