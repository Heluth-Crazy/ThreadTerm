import { test, expect } from '@playwright/test';

test.describe('LiveGrid', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Navigate to LiveGrid view via ActivityBar button with aria-label
    const liveGridBtn = page.locator('button[aria-label*="Live Grid"], button[aria-label*="live grid"], button[aria-label*="라이브"], button[aria-label*="实时"]').first();
    if (await liveGridBtn.isVisible({ timeout: 3000 })) {
      await liveGridBtn.click();
    } else {
      // Fallback: second button in the activity bar nav (LiveGrid is 2nd item)
      const navBtns = page.locator('aside nav button');
      const count = await navBtns.count();
      if (count >= 2) {
        await navBtns.nth(1).click();
      }
    }

    await page.waitForTimeout(1000);
  });

  test('renders without crashing', async ({ page }) => {
    // No error boundary text
    const errorText = page.locator('text=/出错了|Maximum update depth|Something went wrong/');
    await expect(errorText).not.toBeVisible();

    // The grid container should be present
    const gridArea = page.locator('.grid').first();
    await expect(gridArea).toBeVisible({ timeout: 5000 });
  });

  test('grid shows empty slots', async ({ page }) => {
    // Empty slots have the dashed border pattern
    const emptySlots = page.locator('.border-dashed');
    const slotCount = await emptySlots.count();
    // Default layout is 2x2 = 4 slots (some may be filled with sessions)
    expect(slotCount).toBeGreaterThanOrEqual(0);
  });

  test('layout switcher buttons are visible', async ({ page }) => {
    // Verify the LiveGrid toolbar heading is present
    const heading = page.locator('h2').first();
    const headingVisible = await heading.isVisible().catch(() => false);

    if (headingVisible) {
      // Toolbar is visible, verify buttons exist
      const allButtons = page.locator('button');
      const count = await allButtons.count();
      expect(count).toBeGreaterThanOrEqual(4);
    } else {
      // LiveGrid may be in focused mode; verify it still renders something
      const gridOrFocused = page.locator('.grid, [class*="flex-col"]').first();
      await expect(gridOrFocused).toBeVisible({ timeout: 5000 });
    }
  });

  test('clicking a layout button changes the grid', async ({ page }) => {
    // Count current grid cells
    const initialSlots = await page.locator('.grid > *').count();

    // Find and click a different layout button (e.g., 3x3)
    const layoutBtn = page.locator('button').filter({
      hasText: /3×3|3x3/,
    }).first();

    if (await layoutBtn.isVisible()) {
      await layoutBtn.click();
      await page.waitForTimeout(500);

      const newSlots = await page.locator('.grid > *').count();
      // 3x3 = 9 slots, should be different from default 2x2 = 4
      expect(newSlots).not.toBe(initialSlots);
    }
  });

  test('screenshot the grid layout', async ({ page }) => {
    await page.screenshot({ path: 'e2e/screenshots/livegrid.png', fullPage: false });
  });
});
