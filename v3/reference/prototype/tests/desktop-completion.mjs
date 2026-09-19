import { expect } from '@playwright/test';
import { startHarness, enter, act, assert, assertHealthy } from './harness.mjs';

const harness = await startHarness();
async function scenario(name, callback) {
  await harness.scenario(name, async () => {
    const { page, context, errors, requests } = await harness.newPage();
    try { await enter(page, harness.origin); await callback(page); await assertHealthy(page, errors, requests); }
    finally { await context.close(); }
  });
}
async function settings(page) {
  await act(page, 'open-settings'); await act(page, 'settings-open');
  await act(page, 'settings-section', { section: 'controls' });
}

try {
  await scenario('app-window-chrome-contains-overlays-and-can-maximize', async (page) => {
    const windowed = await page.evaluate(() => {
      const desk = document.querySelector('.desktop').getBoundingClientRect();
      const win = document.querySelector('.app-window').getBoundingClientRect();
      return win.width < desk.width - 8 && win.height < desk.height - 8 && getComputedStyle(document.querySelector('.app-window')).borderRadius !== '0px';
    });
    assert.equal(windowed, true, 'App should sit inset on the desktop with rounded corners');
    await act(page, 'open-create');
    const contained = await page.evaluate(() => {
      const win = document.querySelector('.app-window').getBoundingClientRect();
      const overlay = document.querySelector('.overlay').getBoundingClientRect();
      return overlay.left >= win.left - 1 && overlay.right <= win.right + 1 && overlay.top >= win.top - 1 && overlay.bottom <= win.bottom + 1;
    });
    assert.equal(contained, true, 'Create dialog must stay inside the app window');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await act(page, 'app-window-toggle');
    assert.equal(await page.locator('.app-window.is-max').count(), 1);
    await act(page, 'app-window-toggle');
    assert.equal(await page.locator('.app-window.is-max').count(), 0);
  });

  await scenario('project-scope-filters-without-changing-page-and-all-clears-scope', async (page) => {
    await act(page, 'nav', { route: 'terminals' });
    await expect(page.locator('[data-terminal-grid]')).toBeVisible();
    await expect(page.locator('[data-testid="sessions-history"]')).toBeVisible();
    await page.locator('.t-card[data-session="orbit-claude"] .tc-name').click();
    await expect(page.locator('[data-testid="terminals-inspect"]')).toContainText('orbit');
    await act(page, 'sessions-history-jump');
    await expect(page.locator('[data-testid="sessions-history"]')).toBeVisible();
    const url = page.url();
    const before = await page.locator('[data-terminal-grid] .t-card').count();
    await act(page, 'scope-open'); await act(page, 'scope-set', { scope: 'project:orbit' });
    assert.equal(page.url(), url);
    await expect(page.locator('[data-filter="project"]')).toHaveValue('orbit');
    const scoped = await page.locator('[data-terminal-grid] .t-card').count();
    assert.ok(scoped > 0 && scoped < before);
    await act(page, 'scope-open'); await act(page, 'scope-set', { scope: 'orbit-checkout' });
    await expect(page.locator('[data-filter="tree"]')).toHaveValue('orbit-checkout');
    await expect(page.locator('.sidebar [data-action="open-project"]')).toHaveCount(1);
    await act(page, 'scope-open'); await act(page, 'scope-set', { scope: 'all' });
    assert.equal(page.url(), url);
    await expect(page.locator('[data-filter="project"]')).toHaveValue('all');
    await expect(page.locator('[data-filter="tree"]')).toHaveValue('all');
    await expect(page.locator('[data-terminal-grid] .t-card')).toHaveCount(before);
  });

  await scenario('directory-preview-refresh-and-discovery-retain-tree-identity', async (page) => {
    await act(page, 'project-menu', { project: 'orbit' }); await act(page, 'directory-preview');
    await expect(page.locator('.dialog')).toContainText('D:/demo/orbit-web');
    await act(page, 'close-dialog');
    await act(page, 'project-menu', { project: 'orbit' }); await act(page, 'directory-refresh');
    await expect(page.locator('[data-testid="directory-refresh-receipt"]')).toContainText('已同步');
    await act(page, 'close-dialog');
    const before = await page.evaluate(() => Object.keys(window.ThreadTermPrototype.trees));
    await act(page, 'project-menu', { project: 'orbit' }); await act(page, 'discover-tree');
    await act(page, 'discover-tree-select', { tree: 'orbit-checkout' });
    await expect(page.locator('#v3-create-form [name="tree"]')).toHaveValue('orbit-checkout');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => Object.keys(window.ThreadTermPrototype.trees)), before);
  });

  await scenario('usage-estimate-recomputes-after-price-edit', async (page) => {
    await act(page, 'open-project', { project: 'orbit' }); await act(page, 'usage-details', { project: 'orbit' });
    const receipt = page.locator('[data-usage-rows] > .note');
    const before = await receipt.innerText();
    await expect(receipt).toContainText('请求'); await expect(receipt).toContainText('缓存率');
    await page.locator('[data-usage-price="Claude"]').fill('42');
    await page.locator('[data-usage-price="Claude"]').press('Tab');
    assert.notEqual(await receipt.innerText(), before);
  });

  await scenario('empty-worktree-create-cancel-and-eight-branch-disclosure', async (page) => {
    await act(page, 'open-project', { project: 'orbit' });
    const before = await page.evaluate(() => Object.values(window.ThreadTermPrototype.trees).filter((tree) => tree.project === 'orbit').length);
    const sessionsBefore = await page.evaluate(() => window.ThreadTermPrototype.sessions().length);
    await act(page, 'new-tree', { project: 'orbit' });
    await page.locator('#tree-branch').fill('qa/cancelled');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.evaluate(() => Object.values(window.ThreadTermPrototype.trees).filter((tree) => tree.project === 'orbit').length), before);
    for (let index = before; index < 9; index += 1) {
      await act(page, 'open-project', { project: 'orbit' });
      await act(page, 'new-tree', { project: 'orbit' });
      await page.locator('#tree-branch').fill(`qa/branch-${index}`);
      await page.getByRole('button', { name: '创建工作树', exact: true }).click();
    }
    await act(page, 'open-project', { project: 'orbit' });
    // User-created IDs are not based on the seed prefix, so count the entire orbit group.
    const group = page.locator('.proj-group').filter({ has: page.locator('[data-action="open-project"][data-project="orbit"]') });
    await expect(group.locator('.tree-row')).toHaveCount(8);
    await act(page, 'branch-list-toggle', { project: 'orbit' });
    await expect(group.locator('.tree-row')).toHaveCount(9);
    assert.equal(await page.evaluate(() => window.ThreadTermPrototype.sessions().length), sessionsBefore);
    await page.reload();
    await expect(group.locator('.tree-row')).toHaveCount(9);
  });

  await scenario('shortcut-conflict-preserves-binding-and-valid-binding-opens-palette', async (page) => {
    await settings(page);
    const selector = page.locator('[data-shortcut="selector"]');
    await selector.fill('Ctrl+Shift+O'); await selector.press('Tab');
    await expect(selector).toHaveValue('Ctrl+Shift+Space');
    await selector.fill('Ctrl+Shift+P'); await selector.press('Tab');
    await act(page, 'settings-close');
    await page.keyboard.press('Control+Shift+p');
    await expect(page.locator('.palette-input')).toBeVisible();
    await page.keyboard.press('Escape');
    await settings(page);
    await page.locator('[data-action="settings-lightweight"]').check();
    await act(page, 'settings-close');
    await page.keyboard.press('Control+Shift+o');
    await expect(page.locator('.float-term')).toHaveCount(0);
  });
} finally { await harness.finish('desktop-completion-results.json'); }
