import { expect } from '@playwright/test';
import { startHarness, enter, act, assert, assertHealthy } from './harness.mjs';

const harness = await startHarness();
async function openSettings(page, section) {
  await act(page, 'open-settings');
  await act(page, 'settings-open');
  await act(page, 'settings-section', { section });
}

try {
  await harness.scenario('settings-import-whitelists-and-previews-real-differences', async () => {
    const { page, context, errors, requests } = await harness.newPage();
    try {
      await enter(page, harness.origin);
      await openSettings(page, 'data');
      const bundle = { app: 'ThreadTerm', kind: 'threadterm-settings-bundle', schemaVersion: 1, sections: {
        notifications: { enabled: false, mention: false, completed: true, sound: false, preview: true, injected: 'nope' },
        shortcuts: { selector: 'Ctrl+Shift+P', floating: 'Ctrl+Alt+F' },
        mobile: { enabled: true },
      } };
      await page.locator('[data-action="settings-import-text"]').fill(JSON.stringify(bundle));
      await act(page, 'settings-import-preview');
      await expect(page.locator('.import-preview')).toContainText('notifications');
      await expect(page.locator('.import-preview')).toContainText('shortcuts');
      await expect(page.locator('.import-preview')).not.toContainText('mobile');
      await act(page, 'settings-import-apply');
      const imported = await page.evaluate(() => window.ThreadTermPrototype.store.featureStates.settings);
      assert.equal(imported.notifications.enabled, false);
      assert.equal(imported.shortcuts.selector, 'Ctrl+Shift+P');
      assert.equal(imported.mobile.enabled, false);
      assert.equal(imported.notifications.injected, undefined);
      await assertHealthy(page, errors, requests);
    } finally { await context.close(); }
  });

  await harness.scenario('settings-migration-requires-current-safe-precheck', async () => {
    const { page, context, errors, requests } = await harness.newPage();
    try {
      await enter(page, harness.origin);
      await openSettings(page, 'data');
      await page.locator('[data-action="settings-migration-target"]').fill('D:\\ThreadTerm data');
      await act(page, 'settings-migration-precheck');
      await expect(page.locator('.migration-state')).toContainText('precheck failed');
      await page.locator('[data-action="settings-migration-target"]').fill('E:\\ThreadTerm data');
      await act(page, 'settings-migration-start');
      await expect(page.locator('.migration-state')).not.toContainText('copying');
      await act(page, 'settings-migration-precheck');
      await expect(page.locator('.migration-state')).toContainText('precheck passed');
      await act(page, 'settings-migration-start');
      await expect(page.locator('.migration-state')).toContainText('copying');
      await assertHealthy(page, errors, requests);
    } finally { await context.close(); }
  });

  await harness.scenario('settings-migration-cancel-fences-old-timer-and-restart-updates-location', async () => {
    const { page, context, errors, requests } = await harness.newPage();
    try {
      await enter(page, harness.origin);
      await openSettings(page, 'data');
      const target = page.locator('[data-action="settings-migration-target"]');
      await target.fill('E:\\ThreadTerm A');
      await act(page, 'settings-migration-precheck');
      await act(page, 'settings-migration-start');
      await act(page, 'settings-migration-cancel');
      await target.fill('F:\\ThreadTerm B');
      await act(page, 'settings-migration-precheck');
      await act(page, 'settings-migration-start');
      await page.waitForTimeout(450);
      const migration = await page.evaluate(() => window.ThreadTermPrototype.store.featureStates.settings.data.migration);
      assert.equal(migration.target, 'F:\\ThreadTerm B');
      assert.notEqual(migration.status, 'cancelled; source retained');
      await expect(page.locator('.migration-state')).toContainText('completed · restart required', { timeout: 3000 });
      await act(page, 'settings-migration-restart');
      await expect(page.locator('[data-settings-section="data"]')).toContainText('F:\\ThreadTerm B');
      await act(page, 'settings-migration-cleanup');
      await expect(page.locator('.dialog')).toContainText('清理已保留源');
      await act(page, 'settings-migration-cleanup-confirm');
      await expect(page.locator('.migration-state')).toContainText('source cleanup complete');
      await act(page, 'settings-migration-rollback');
      await expect(page.locator('[data-settings-section="data"]')).toContainText('F:\\ThreadTerm B');
      await assertHealthy(page, errors, requests);
    } finally { await context.close(); }
  });

  await harness.scenario('settings-mobile-expiry-token-and-command-receipt', async () => {
    const { page, context, errors, requests } = await harness.newPage();
    try {
      await enter(page, harness.origin);
      await openSettings(page, 'mobile');
      await page.locator('[data-action="settings-mobile"]').check();
      await page.locator('[data-action="settings-mobile-access"]').selectOption('full');
      await act(page, 'settings-device-connect');
      await expect(page.locator('[data-action="settings-device-command"]')).toBeEnabled();
      await act(page, 'settings-device-command');
      await expect(page.locator('[data-command-receipt]')).toContainText('回执');
      await page.locator('[data-action="settings-device-rename"]').last().click();
      await expect(page.locator('.dialog [data-device-name]')).toBeVisible();
      await page.locator('[data-device-name]').fill('QA full-control device');
      await act(page, 'settings-device-rename-save');
      await expect(page.locator('.device-list')).toContainText('QA full-control device');
      await act(page, 'settings-mobile-expire');
      await expect(page.locator('[data-action="settings-device-connect"]')).toBeDisabled();
      await expect(page.locator('[data-action="settings-device-command"]')).toBeEnabled();
      await act(page, 'settings-close');
      await act(page, 'open-scenarios');
      await act(page, 'settings-scene', { scene: 'token-expired' });
      await expect(page.locator('[data-action="settings-device-command"]')).toBeDisabled();
      await assertHealthy(page, errors, requests);
    } finally { await context.close(); }
  });

  await harness.scenario('settings-migration-rollback-restores-retained-activated-source', async () => {
    const { page, context, errors, requests } = await harness.newPage();
    try {
      await enter(page, harness.origin);
      await openSettings(page, 'data');
      await page.locator('[data-action="settings-migration-target"]').fill('E:\\Rollback target');
      await act(page, 'settings-migration-precheck');
      await act(page, 'settings-migration-start');
      await expect(page.locator('.migration-state')).toContainText('completed · restart required', { timeout: 3000 });
      await act(page, 'settings-migration-restart');
      await expect(page.locator('[data-settings-section="data"]')).toContainText('E:\\Rollback target');
      await act(page, 'settings-migration-rollback');
      await expect(page.locator('[data-settings-section="data"]')).toContainText('D:\\ThreadTerm data');
      await assertHealthy(page, errors, requests);
    } finally { await context.close(); }
  });

  await harness.scenario('settings-theme-import-requires-reviewable-valid-json', async () => {
    const { page, context, errors, requests } = await harness.newPage();
    try {
      await enter(page, harness.origin);
      await openSettings(page, 'appearance');
      await act(page, 'settings-theme-import');
      await expect(page.locator('.dialog [data-theme-import-json]')).toBeVisible();
      await page.locator('[data-theme-import-json]').fill('{"id":"bad","name":"Bad","accent":"red"}');
      await act(page, 'settings-theme-import-confirm');
      await expect(page.locator('.dialog')).toBeVisible();
      await page.locator('[data-theme-import-json]').fill('{"id":"violet","name":"Violet","accent":"#9b7bff"}');
      await act(page, 'settings-theme-import-confirm');
      await expect(page.locator('.theme-list')).toContainText('Violet');
      await assertHealthy(page, errors, requests);
    } finally { await context.close(); }
  });

  await harness.scenario('settings-compatibility-and-notification-test-state-are-visible', async () => {
    const { page, context, errors, requests } = await harness.newPage();
    try {
      await enter(page, harness.origin);
      await openSettings(page, 'controls');
      await expect(page.locator('[data-action="settings-ai-completion"]')).toBeChecked();
      await page.locator('[data-action="settings-ai-completion"]').locator('xpath=..').click();
      assert.equal(await page.evaluate(() => window.ThreadTermPrototype.store.featureStates.settings.compatibility.aiCompletion), false);
      await act(page, 'settings-notification-test');
      await expect(page.locator('[data-notification-receipt]')).toContainText('送达');
      await page.locator('[data-action="settings-notifications"]').locator('xpath=..').click();
      await act(page, 'settings-notification-test');
      await expect(page.locator('[data-notification-receipt]')).toContainText('关闭');
      await assertHealthy(page, errors, requests);
    } finally { await context.close(); }
  });

  await harness.scenario('settings-external-tool-lifecycle-is-reviewable-and-windows-guarded', async () => {
    const { page, context, errors, requests } = await harness.newPage();
    try {
      await enter(page, harness.origin);
      await openSettings(page, 'tools');
      await expect(page.locator('.tool-lifecycle')).toBeVisible();
      const cwd = page.locator('[data-tool-cwd]');
      await cwd.fill('relative\\folder');
      await act(page, 'settings-tool-create');
      await expect(page.locator('[data-tool-receipt]')).toContainText('未创建');
      await cwd.fill('D:\\project\\orbit');
      await page.locator('[data-tool-target]').selectOption('separate-window');
      await page.locator('[data-tool-mode]').selectOption('focus');
      await act(page, 'settings-tool-create');
      await expect(page.locator('.tool-run-list')).toContainText('separate-window');
      await expect(page.locator('[data-tool-receipt]')).toContainText('已创建');
      await page.locator('[data-action="settings-tool-show"]').click();
      await expect(page.locator('[data-tool-receipt]')).toContainText('显示');
      await page.locator('[data-action="settings-tool-close"][data-close="graceful"]').click();
      await expect(page.locator('.tool-run-list')).toContainText('closed gracefully');
      await page.locator('[data-action="settings-tool-close"][data-close="force"]').click();
      await expect(page.locator('.tool-run-list')).toContainText('force closed');
      await assertHealthy(page, errors, requests);
    } finally { await context.close(); }
  });
} finally {
  await harness.finish('settings-review-results.json');
}
