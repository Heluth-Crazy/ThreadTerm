import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const DESCRIPTOR_ENV = 'THREADTERM_REAL_BRIDGE_DESCRIPTOR_PATH';

interface RealBridgeDescriptor {
  pairUrl: string;
  serverId: string;
  port: number;
  cardName: string;
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
  expect(pageErrors).toEqual([]);
});

function readDescriptor(): RealBridgeDescriptor {
  const descriptorPath = process.env[DESCRIPTOR_ENV];
  if (!descriptorPath) {
    throw new Error(`${DESCRIPTOR_ENV} was not set by the real bridge global setup`);
  }
  return JSON.parse(readFileSync(descriptorPath, 'utf8')) as RealBridgeDescriptor;
}
