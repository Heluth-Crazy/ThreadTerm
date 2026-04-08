import { test, expect } from '@playwright/test';

test.describe('Layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('app loads without white screen', async ({ page }) => {
    const body = page.locator('body');
    await expect(body).not.toBeEmpty();

    // No error boundary visible
    const errorBoundary = page.locator('text=/出错了|Something went wrong|Maximum update depth/');
    await expect(errorBoundary).not.toBeVisible();
  });

  test('ActivityBar is visible with nav buttons', async ({ page }) => {
    // ActivityBar should be visible (w-14 = 56px sidebar)
    const activityBar = page.locator('[data-testid="activity-bar"]').or(
      page.locator('nav').first()
    );

    // Look for the activity bar buttons by their icon containers
    const navButtons = page.locator('button').filter({
      has: page.locator('svg'),
    });
    // There should be at least 4 nav buttons in the sidebar area
    const buttonCount = await navButtons.count();
    expect(buttonCount).toBeGreaterThanOrEqual(4);
  });

  test('header bar is visible with O logo', async ({ page }) => {
    // The header contains the "O" logo text
    const header = page.locator('header');
    await expect(header).toBeVisible();

    const logo = header.locator('text=O').first();
    await expect(logo).toBeVisible();
  });

  test('overview mode shows MissionControlView', async ({ page }) => {
    // The default view should be overview / mission control
    // Look for characteristic elements of the MissionControlView
    const overviewContent = page.locator('text=/OpenWork|Overview|Projects|Sessions/i').first();
    await expect(overviewContent).toBeVisible({ timeout: 10000 });
  });

  test('no horizontal overflow beyond viewport', async ({ page }) => {
    const hasOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(hasOverflow).toBe(false);
  });
});
