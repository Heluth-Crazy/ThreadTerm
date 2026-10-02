import { startHarness, enter, act, assertHealthy, assert } from './harness.mjs';

const harness = await startHarness();

async function scenario(name, callback) {
  await harness.scenario(name, async () => {
    const { page, context, errors, requests } = await harness.newPage();
    try {
      await enter(page, harness.origin);
      await callback(page);
      await assertHealthy(page, errors, requests);
    } finally {
      await context.close();
    }
  });
}

try {
  await scenario('project-catalog-actions-are-distinct', async (page) => {
    const projectMenu = page.locator('[data-action="project-menu"][data-project="pulse"]');
    await projectMenu.hover();
    await projectMenu.click();
    await act(page, 'project-pin', { project: 'pulse' });
    assert.ok(await page.evaluate(() => window.ThreadTermPrototype.store.pinnedProjects.includes('pulse')));

    await projectMenu.hover();
    await projectMenu.click();
    await act(page, 'project-rename', { project: 'pulse' });
    await page.locator('#project-rename-input').fill('Pulse renamed');
    await page.locator('#project-rename-form').press('Enter');
    await page.waitForTimeout(50);
    assert.match(await page.locator('[data-action="open-project"][data-project="pulse"]').first().innerText(), /Pulse renamed/);

    await projectMenu.hover();
    await projectMenu.click();
    await act(page, 'catalog-archive', { kind: 'project', id: 'pulse' });
    await act(page, 'catalog-archive-confirm', { kind: 'project', id: 'pulse' });
    assert.ok(await page.locator('.side-label').filter({ hasText: '已归档项目' }).count());
    await projectMenu.hover();
    await projectMenu.click();
    await act(page, 'catalog-restore', { kind: 'project', id: 'pulse' });
    assert.equal(await page.evaluate(() => window.ThreadTermPrototype.store.archivedProjects.includes('pulse')), false);
  });

  await scenario('all-terminals-protects-order-while-filtered', async (page) => {
    await act(page, 'nav', { route: 'terminals' });
    const orderBefore = await page.evaluate(() => JSON.stringify(window.ThreadTermPrototype.store.sessionOrder));
    await page.locator('[data-action="t-search"]').fill('checkout');
    const grid = page.locator('[data-terminal-grid]');
    await grid.waitFor();
    await assert.equal(await grid.getAttribute('data-order-locked'), 'true');
    assert.match(await page.locator('.t-order-note').innerText(), /清除/);
    assert.equal(await page.evaluate(() => JSON.stringify(window.ThreadTermPrototype.store.sessionOrder)), orderBefore);
  });

  await scenario('quick-selector-pin-is-independent-and-capped', async (page) => {
    await act(page, 'nav', { route: 'terminals' });
    await act(page, 'card-menu', { session: 'orbit-claude' });
    await act(page, 'session-pin', { session: 'orbit-claude' });
    assert.ok(await page.evaluate(() => window.ThreadTermPrototype.store.pinnedSessionIds.includes('orbit-claude')));
    assert.equal(await page.evaluate(() => window.ThreadTermPrototype.store.followed.includes('orbit-claude')), false);
    await act(page, 'open-palette');
    await page.locator('.palette-input').fill('checkout keyboard fix');
    await assert.equal(await page.locator('.cmd-group').filter({ hasText: '快捷选择' }).count(), 1);
  });

  await scenario('workspace-visit-order-and-keyboard-navigation', async (page) => {
    await act(page, 'open-session', { session: 'orbit-claude' });
    await page.keyboard.press('Alt+ArrowRight');
    assert.match(page.url(), /#\/workspace\/orbit-/);
    await page.locator('[data-action="ws-grid"]').waitFor();
    assert.equal(await page.locator('[data-action="ws-grid"]').count(), 1);
    await act(page, 'ws-grid');
    await page.waitForURL(/#\/terminals$/);
    assert.equal(await page.locator('[data-action="open-session"][data-session="orbit-claude"]').count() > 0, true);
  });

  await scenario('workspace-split-float-and-preset-commands-stay-scoped', async (page) => {
    await act(page, 'open-session', { session: 'orbit-claude' });
    const original = await page.locator('[data-terminal-form]').getAttribute('data-terminal-form');
    await page.locator('[data-terminal-form] input').fill('retain this preset draft');
    while (await page.locator('.ws-tile').count() < 4) {
      await act(page, 'tile-open-add');
      const candidate = page.locator('[data-action="tile-add"]').first();
      if (!await candidate.count()) break;
      await candidate.click();
    }
    assert.equal(await page.locator('.ws-tile').count(), 4);
    const tileIds = await page.locator('.ws-tile').evaluateAll((tiles) => tiles.map((tile) => tile.dataset.session));
    const trees = await page.evaluate((ids) => ids.map((id) => window.ThreadTermPrototype.sessionById(id).tree), tileIds);
    assert.deepEqual([...new Set(trees)], ['orbit-checkout']);
    const candidateId = tileIds.find((id) => id !== original);
    await page.locator(`[data-action="tile-pop"][data-session="${candidateId}"]`).click();
    await page.locator('.float-term').waitFor();
    assert.match(await page.locator('.float-title').innerText(), /·/);
    await act(page, 'float-close');
    assert.equal(await page.locator('.float-term').count(), 0);
    assert.equal(await page.locator('[data-action="float-resume"]').count(), 0);
    await page.evaluate((id) => {
      window.ThreadTermPrototype.ui.float = { sessionId: id, visibility: 'open', pinned: false };
      window.ThreadTermPrototype.render();
    }, original);
    await page.locator('.float-term').waitFor();
    await act(page, 'float-hide');
    assert.equal(await page.locator('.float-term').count(), 0);
    assert.equal(await page.locator('[data-action="float-resume"]').count(), 1);
    await act(page, 'float-close');
    assert.equal(await page.locator('[data-action="float-resume"]').count(), 0);
    assert.equal(await page.evaluate(() => window.ThreadTermPrototype.ui.float.visibility), 'closed');
    await page.evaluate((id) => {
      window.ThreadTermPrototype.ui.float = { sessionId: id, visibility: 'open', pinned: false };
      window.ThreadTermPrototype.render();
    }, original);
    await page.locator('.float-term').waitFor();
    await act(page, 'float-main');

    await act(page, 'nav', { route: 'presets' });
    await page.locator('[data-action="preset-open"]').first().click();
    const entry = page.locator('[data-preset-entry]:not(:disabled)').first();
    await entry.uncheck();
    await entry.check();
    await act(page, 'preset-confirm');
    await page.locator('.preset-cols').waitFor();
    assert.equal(await page.locator('.pcol-ctx .cmd-opt').count() > 0, true);
    assert.equal(await page.evaluate(() => Object.values(window.ThreadTermPrototype.ui.logs).flat().some((line) => line.includes('pnpm test -- checkout'))), false);
    await act(page, 'exit-preset');
    await act(page, 'open-session', { session: original });
    assert.equal(await page.locator(`[data-terminal-form="${original}"] input`).inputValue(), 'retain this preset draft');
  });

  await scenario('usage-details-filter-and-pagination', async (page) => {
    await act(page, 'open-project', { project: 'orbit' });
    for (const action of ['follow-add', 'activity-all', 'usage-details']) {
      const control = page.locator(`[data-action="${action}"]`).first();
      await control.waitFor({ state: 'visible' });
      const clipped = await control.evaluate((node) => {
        const parent = node.closest('.brief-sec, .usage-panel, .metric-strip');
        if (!parent) return true;
        const a = node.getBoundingClientRect();
        const b = parent.getBoundingClientRect();
        return a.top < b.top - 1 || a.bottom > b.bottom + 1 || a.left < b.left - 1 || a.right > b.right + 1;
      });
      assert.equal(clipped, false, `${action} clipped by parent`);
    }
    assert.equal(await page.locator('.metric-strip .usage-panel [data-action="usage-details"]').count(), 1);
    assert.equal(await page.locator('.brief-page > .usage-panel').count(), 0);
    await act(page, 'activity-all', { project: 'orbit' });
    const activity = page.locator('[data-testid="project-activity"]');
    await activity.waitFor();
    assert.match(await page.locator('.dialog').innerText(), /仅展示本地保留记录/);
    assert.equal(await page.locator('.activity-row').count() > 0, true);
    await act(page, 'close-dialog');
    await act(page, 'usage-details', { project: 'orbit' });
    const rows = page.locator('[data-usage-rows]');
    await rows.waitFor();
    assert.equal(await page.locator('[data-action="usage-page"][data-direction="1"]').isDisabled(), false);
    await act(page, 'usage-page', { direction: '1' });
    assert.match(await rows.innerText(), /Unknown|未知/);
    await act(page, 'usage-page', { direction: '-1' });
    await page.locator('[data-usage-filter="provider"]').selectOption('Claude');
    assert.match(await rows.innerText(), /Claude/);
    await page.locator('[data-usage-price="Claude"]').fill('19.5');
    await page.locator('[data-usage-price="Claude"]').press('Tab');
    assert.equal(await page.evaluate(() => window.ThreadTermPrototype.store.featureStates.coreUsage.prices.Claude), 19.5);
  });

  await scenario('multi-follow-cancel-submit-and-worktree-guards', async (page) => {
    const before = await page.evaluate(() => [...window.ThreadTermPrototype.store.followed].sort());
    await act(page, 'open-tree', { tree: 'orbit-checkout' });
    await page.locator('.wt-branch').waitFor();
    await page.locator('.metric-strip .usage-panel.no-details').waitFor();
    assert.equal(await page.locator('.brief-page > .usage-panel').count(), 0);
    await act(page, 'follow-add');
    const pick = page.locator('[data-follow-pick]:not(:checked)').first();
    await pick.check();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => [...window.ThreadTermPrototype.store.followed].sort()), before);
    await act(page, 'follow-add');
    const chosen = page.locator('[data-follow-pick]:not(:checked)').first();
    const chosenId = await chosen.getAttribute('value');
    await chosen.check();
    await page.getByRole('button', { name: '确认', exact: true }).click();
    assert.ok(await page.evaluate((id) => window.ThreadTermPrototype.store.followed.includes(id), chosenId));

    await act(page, 'remove-tree', { tree: 'orbit-checkout' });
    assert.match(await page.locator('.dialog').innerText(), /不能移除|运行/);
    assert.equal(await page.locator('[data-action="confirm-remove-tree"]').count(), 0);
    await act(page, 'close-dialog');
    await act(page, 'open-tree', { tree: 'orbit-missing' });
    await act(page, 'relocate', { tree: 'orbit-missing' });
    await page.locator('#relocate-path').fill('D:/demo/orbit-web-legacy-restored');
    await page.locator('#relocate-form').press('Enter');
    assert.match(await page.locator('.page-sub').first().innerText(), /orbit-web-legacy-restored/);
  });

  await scenario('notifications-read-without-resolving', async (page) => {
    const source = JSON.stringify({ sentinel: 'source-v1' });
    await page.evaluate((value) => localStorage.setItem('threadterm.app.v1', value), source);
    await act(page, 'open-notifications');
    const episode = await page.locator('[data-action="notif-open"]').first().getAttribute('data-episode');
    await act(page, 'notif-open', { episode });
    assert.ok(await page.evaluate((id) => window.ThreadTermPrototype.store.notifRead.includes(id), episode));
    assert.equal(await page.evaluate((id) => window.ThreadTermPrototype.store.resolved.includes(id), episode), false);
  });

  await scenario('reset-isolates-v3-storage', async (page) => {
    const source = JSON.stringify({ sentinel: 'source-v1' });
    await page.evaluate((value) => localStorage.setItem('threadterm.app.v1', value), source);
    const reset = page.waitForNavigation();
    await page.evaluate(() => setTimeout(() => window.ThreadTermPrototype.resetPrototype(), 100));
    await reset;
    await page.waitForLoadState('domcontentloaded');
    assert.match(page.url(), /#\/workbench$/);
    assert.equal(await page.evaluate(() => localStorage.getItem('threadterm.app.v1')), source);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('threadterm.app.v3')).theme), 'light');
  });
} finally {
  await harness.finish('core-review-results.json');
}
