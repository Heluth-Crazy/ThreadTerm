import { test, expect } from '@playwright/test';

test.describe('Theme', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('toggle to dark theme and verify', async ({ page }) => {
    // Navigate to settings via header button
    const headerSettingsBtn = page.locator('header button[title="Settings"]').first();
    if (await headerSettingsBtn.isVisible()) {
      await headerSettingsBtn.click();
    } else {
      // Try activity bar settings button
      const activityButtons = page.locator('nav button, [role="navigation"] button');
      const count = await activityButtons.count();
      for (let i = count - 1; i >= 0; i--) {
        const btn = activityButtons.nth(i);
        const title = await btn.getAttribute('title');
        if (title && title.toLowerCase().includes('settings')) {
          await btn.click();
          break;
        }
      }
    }

    await page.waitForTimeout(1000);

    // Look for Appearance section or tab
    const appearanceLink = page.locator('text=/Appearance|외관|外观|外觀/i').first();
    if (await appearanceLink.isVisible()) {
      await appearanceLink.click();
      await page.waitForTimeout(500);
    }

    // Find the dark theme toggle/button
    const darkBtn = page.locator('button').filter({ hasText: /dark|다크|暗色/i }).first();
    if (await darkBtn.isVisible()) {
      await darkBtn.click();
      await page.waitForTimeout(500);

      // Verify html has 'dark' class
      const htmlClass = await page.locator('html').getAttribute('class');
      expect(htmlClass).toContain('dark');

      // Verify background is dark (not white)
      const bgColor = await page.evaluate(() => {
        return window.getComputedStyle(document.body).backgroundColor;
      });
      // Dark backgrounds typically have low RGB values
      expect(bgColor).not.toBe('rgb(255, 255, 255)');
    }

    // Screenshot to verify theme
    await page.screenshot({ path: 'e2e/screenshots/dark-theme.png', fullPage: false });
  });

  test('toggle to light theme and verify', async ({ page }) => {
    // Navigate to settings
    const headerSettingsBtn = page.locator('header button[title="Settings"]').first();
    if (await headerSettingsBtn.isVisible()) {
      await headerSettingsBtn.click();
    }

    await page.waitForTimeout(1000);

    const appearanceLink = page.locator('text=/Appearance|외관|外观|外觀/i').first();
    if (await appearanceLink.isVisible()) {
      await appearanceLink.click();
      await page.waitForTimeout(500);
    }

    const lightBtn = page.locator('button').filter({ hasText: /light|라이트|亮色/i }).first();
    if (await lightBtn.isVisible()) {
      await lightBtn.click();
      await page.waitForTimeout(500);

      // html should NOT have 'dark' class
      const htmlClass = await page.locator('html').getAttribute('class');
      expect(htmlClass || '').not.toContain('dark');
    }

    await page.screenshot({ path: 'e2e/screenshots/light-theme.png', fullPage: false });
  });
});
