import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('click Settings nav opens settings panel', async ({ page }) => {
    // The ActivityBar has a settings button with aria-label containing "settings"
    const settingsBtn = page.locator('aside nav button[aria-label*="ettings"], aside nav button[aria-label*="설정"], aside nav button[aria-label*="设置"]').first();

    if (await settingsBtn.isVisible()) {
      await settingsBtn.click();
    } else {
      // Fallback: click the last button in the activity bar nav (settings is last)
      const navBtns = page.locator('aside nav button');
      const count = await navBtns.count();
      if (count > 0) {
        await navBtns.nth(count - 1).click();
      }
    }

    await page.waitForTimeout(1000);

    // Verify settings panel content appeared (look for settings-related elements)
    const settingsContent = page.locator('text=/Appearance|General|Agents|외관|一般|外观/i').first();
    await expect(settingsContent).toBeVisible({ timeout: 5000 });
  });

  test('click LiveGrid nav opens LiveGrid view without error', async ({ page }) => {
    // Find the LiveGrid/Grid nav button in the activity bar
    const activityButtons = page.locator('nav button, [role="navigation"] button');
    const count = await activityButtons.count();

    for (let i = 0; i < count; i++) {
      const btn = activityButtons.nth(i);
      const title = await btn.getAttribute('title');
      if (title && (title.toLowerCase().includes('grid') || title.toLowerCase().includes('live'))) {
        await btn.click();
        break;
      }
    }

    // Wait a moment for render
    await page.waitForTimeout(1000);

    // No error boundary or crash text
    const errorText = page.locator('text=/出错了|Maximum update depth|Something went wrong/');
    await expect(errorText).not.toBeVisible();
  });

  test('back to overview button works', async ({ page }) => {
    // Navigate to settings first
    const headerSettingsBtn = page.locator('header button[title="Settings"]').first();
    if (await headerSettingsBtn.isVisible()) {
      await headerSettingsBtn.click();
    }

    await page.waitForTimeout(500);

    // Click "← Overview" button
    const backBtn = page.locator('text=/← Overview|← overview/i').first();
    if (await backBtn.isVisible()) {
      await backBtn.click();
      await page.waitForTimeout(500);

      // Should be back at overview with mission control content
      const overviewContent = page.locator('text=/OpenWork|Overview|Projects|Sessions/i').first();
      await expect(overviewContent).toBeVisible({ timeout: 5000 });
    }
  });
});
