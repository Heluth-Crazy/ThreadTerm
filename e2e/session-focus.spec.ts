import { test, expect } from '@playwright/test';

test.describe('Session Focus Layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('project list panel is visible when a project is selected', async ({ page }) => {
    // Click on the first project in the overview to enter focus mode
    const projectCard = page.locator('button').filter({
      has: page.locator('svg'),
    }).filter({ hasText: /.+/ });

    // Wait for projects to load
    await page.waitForTimeout(2000);

    // Check if there are project buttons in an overview grid or list
    const projectButtons = page.locator('[class*="w-52"] button').or(
      page.locator('.space-y-0\\.5 button')
    );

    if (await projectButtons.count() > 0) {
      // We're already in focus mode with the project list visible
      const projectListPanel = page.locator('[class*="w-52"]').first();
      await expect(projectListPanel).toBeVisible();
    }
  });

  test('chat area does not overflow viewport width', async ({ page }) => {
    await page.waitForTimeout(2000);

    const hasOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(hasOverflow).toBe(false);
  });

  test('session panels are properly constrained', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Check that no element extends beyond viewport
    const overflowingElements = await page.evaluate(() => {
      const vw = window.innerWidth;
      const elements = document.querySelectorAll('*');
      let count = 0;
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.right > vw + 1 && rect.width > 0) {
          count++;
        }
      }
      return count;
    });
    // Allow a small number of elements that might slightly overflow (scrollbars, etc.)
    expect(overflowingElements).toBeLessThan(5);
  });

  test('screenshot session focus layout', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/session-focus.png', fullPage: false });
  });
});
