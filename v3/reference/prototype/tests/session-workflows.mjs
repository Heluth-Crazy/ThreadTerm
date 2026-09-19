import { expect } from '@playwright/test';
import { startHarness, enter, act, assert, assertHealthy, screenshot } from './harness.mjs';

const harness = await startHarness();
const only = process.env.PROTOTYPE_TEST || '';
async function scenario(name, callback) {
  if (only && !name.includes(only)) return;
  await harness.scenario(name, async () => {
    const { page, context, errors, requests } = await harness.newPage();
    try {
      await enter(page, harness.origin);
      await callback(page);
      await assertHealthy(page, errors, requests);
    } catch (error) {
      await screenshot(page, `failure-${name}`);
      throw error;
    } finally { await context.close(); }
  });
}

async function create(page, options = {}) {
  const beforeUrl = page.url();
  await page.locator('[data-action="open-create"], [data-action="sessions-new"]').filter({ visible: true }).first().click();
  const form = page.locator('#v3-create-form');
  await form.locator(`[data-create-agent="${options.agent || 'Codex'}"]`).click();
  await form.locator(`[data-create-mode="${options.mode || 'terminal'}"]`).click();
  await form.locator('[name="name"]').fill(options.name || 'Workflow test');
  if (options.cwd) await form.locator('[name="cwd"]').fill(options.cwd);
  if (options.oneShot) await form.locator('input[name="exec"][value="oneShot"]').check();
  if (options.preset) await form.locator('[name="preset"]').selectOption(options.preset);
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.waitForURL((url) => url.toString() !== beforeUrl && url.hash.startsWith('#/workspace/'));
  return decodeURIComponent(page.url().split('/workspace/')[1]);
}

async function history(page, scan = true) {
  await act(page, 'nav', { route: 'terminals' });
  await act(page, 'sessions-history-jump');
  if (scan) {
    await act(page, 'sessions-history-scan');
    await expect(page.locator('[data-testid="history-scan-status"]')).toContainText('扫描完成');
  }
}

async function queryHistory(page, query) {
  await page.locator('[data-action="sessions-history-provider"]').selectOption('all');
  await page.locator('[data-action="sessions-history-filter"]').selectOption('all');
  await page.locator('[data-action="sessions-history-query"]').fill(query);
}

try {
  await scenario('history-scan-cancel-error-filter-pagination', async (page) => {
    await history(page, false);
    const before = await page.locator('[data-history-row]').count();
    await act(page, 'sessions-history-scan');
    await act(page, 'sessions-history-cancel');
    await page.waitForTimeout(1000);
    assert.equal(await page.locator('[data-history-row]').count(), before);
    await act(page, 'sessions-history-scan');
    await act(page, 'sessions-history-error');
    await page.waitForTimeout(1000);
    await expect(page.locator('.v3-error')).toContainText('扫描中断');
    assert.equal(await page.locator('[data-history-row]').count(), before);
    await act(page, 'sessions-history-scan');
    await expect(page.locator('[data-testid="history-scan-status"]')).toContainText('扫描完成');
    await expect(page.locator('[data-history-row]')).toHaveCount(10);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.locator('[data-testid="history-page"]')).toContainText('2 /');
    await page.locator('[data-action="sessions-history-provider"]').selectOption('Kimi');
    await expect(page.locator('[data-testid="history-page"]')).toContainText('1 / 1');
    assert.ok((await page.locator('[data-history-row]').allTextContents()).every((text) => text.includes('Kimi')));
    await page.locator('[data-action="sessions-history-query"]').fill('旧目录');
    await expect(page.locator('[data-history-row]')).toHaveCount(1);
  });

  await scenario('history-read-root-validation-shell-boundary', async (page) => {
    await history(page);
    const count = await page.evaluate(() => window.ThreadTermPrototype.sessions().length);
    await queryHistory(page, '子记录');
    await act(page, 'sessions-history-detail', { history: 'scan-codex-child' });
    await expect(page.locator('.dialog')).toContainText('只读子记录');
    await act(page, 'close-dialog');
    await act(page, 'sessions-history-resume', { history: 'scan-codex-child' });
    await expect(page.locator('.dialog')).toContainText('不是可交互根会话');
    await act(page, 'close-dialog');
    await queryHistory(page, '上次构建输出');
    await expect(page.locator('[data-history-row="scan-shell-output"]')).toContainText('Shell 只读');
    await expect(page.locator('[data-history-row="scan-shell-output"] [data-action="sessions-history-resume"]')).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.ThreadTermPrototype.sessions().length), count);
  });

  await scenario('history-import-resume-reuses-active-and-archived-owner', async (page) => {
    await history(page);
    await queryHistory(page, 'Codex · 结账键盘复核');
    const count = await page.evaluate(() => window.ThreadTermPrototype.sessions().length);
    await act(page, 'sessions-history-import-card', { history: 'scan-codex-1' });
    assert.equal(await page.evaluate(() => window.ThreadTermPrototype.sessions().length), count + 1);
    await act(page, 'sessions-history-resume', { history: 'scan-codex-1' });
    await page.locator('#v3-resume-mode').selectOption('chat');
    await act(page, 'sessions-history-confirm', { history: 'scan-codex-1' });
    await expect(page.locator('[data-v3-chat-form]')).toBeVisible();
    await expect(page.locator('.v3-chat-log')).toContainText('两个需要复核的焦点边界');
    const sid = decodeURIComponent(page.url().split('/workspace/')[1]);
    assert.equal(await page.evaluate(() => window.ThreadTermPrototype.sessions().length), count + 1);
    await history(page, false);
    await queryHistory(page, 'Codex · 结账键盘复核');
    await act(page, 'sessions-history-open-bound', { history: 'scan-codex-1' });
    await expect(page).toHaveURL(new RegExp(`${sid}$`));
    await act(page, 'session-menu', { session: sid });
    await act(page, 'catalog-archive', { kind: 'session', id: sid });
    await act(page, 'catalog-archive-confirm', { kind: 'session', id: sid });
    await history(page, false);
    await queryHistory(page, 'Codex · 结账键盘复核');
    await act(page, 'sessions-history-open-bound', { history: 'scan-codex-1' });
    await expect(page.locator('.dialog')).toContainText('已有归档卡片');
    await act(page, 'sessions-history-unarchive', { history: 'scan-codex-1' });
    await expect(page).toHaveURL(new RegExp(`${sid}$`));
    assert.equal(await page.evaluate(() => window.ThreadTermPrototype.sessions().length), count + 1);
  });

  await scenario('history-missing-directory-confirmed-relocation', async (page) => {
    await history(page);
    await queryHistory(page, '旧目录中的任务');
    await act(page, 'sessions-history-relocate', { history: 'scan-kimi-missing' });
    await page.locator('#v3-relocate-form [name="path"]').fill('relative/path');
    await page.getByRole('button', { name: '确认重新定位', exact: true }).click();
    await expect(page.locator('#v3-relocate-form')).toBeVisible();
    await page.locator('#v3-relocate-form [name="target"]').selectOption('D:/demo/orbit-web-checkout');
    await page.getByRole('button', { name: '确认重新定位', exact: true }).click();
    await act(page, 'sessions-history-resume', { history: 'scan-kimi-missing' });
    await act(page, 'sessions-history-confirm', { history: 'scan-kimi-missing' });
    await expect(page).toHaveURL(/#\/workspace\//);
    const cwd = await page.evaluate(() => {
      const api = window.ThreadTermPrototype;
      return api.trees[api.sessionById(api.ui.route.sessionId).tree].path;
    });
    assert.equal(cwd, 'D:/demo/orbit-web-checkout');
  });

  await scenario('one-shot-completes-keeps-output-runs-again', async (page) => {
    const sid = await create(page, { agent: '命令预设', oneShot: true, preset: 'node server.js' });
    await expect.poll(() => page.evaluate((id) => window.ThreadTermPrototype.isEnded(window.ThreadTermPrototype.sessionById(id)), sid)).toBe(true);
    await act(page, 'nav', { route: 'terminals' });
    await act(page, 'session-menu', { session: sid });
    await act(page, 'sessions-run', { session: sid });
    assert.equal(await page.evaluate((id) => window.ThreadTermPrototype.isEnded(window.ThreadTermPrototype.sessionById(id)), sid), false);
    await expect.poll(() => page.evaluate((id) => window.ThreadTermPrototype.isEnded(window.ThreadTermPrototype.sessionById(id)), sid)).toBe(true);
    assert.ok(await page.evaluate((id) => window.ThreadTermPrototype.sessionById(id).output.filter((line) => line.includes('退出码 0')).length >= 2, sid));
  });

  await scenario('custom-directory-identity-survives-reload', async (page) => {
    const path = 'D:\\demo\\new-workflow-folder';
    const sid = await create(page, { cwd: path });
    const before = await page.evaluate((id) => { const api = window.ThreadTermPrototype; const item = api.sessionById(id); return [item.tree, api.trees[item.tree].path]; }, sid);
    assert.equal(before[1], path);
    await page.reload();
    assert.deepEqual(await page.evaluate((id) => { const api = window.ThreadTermPrototype; const item = api.sessionById(id); return [item.tree, api.trees[item.tree].path]; }, sid), before);
  });

  await scenario('automatic-retry-disable-cancels-pending-run', async (page) => {
    const sid = await create(page);
    await act(page, 'sessions-config', { session: sid });
    await page.locator('#v3-config-form [name="retry"]').selectOption('automatic');
    await page.locator('[data-v3-save="next"]').click();
    await act(page, 'sessions-fail', { session: sid });
    await expect(page.locator('[data-action="sessions-cancel-retry"]')).toBeVisible();
    await act(page, 'sessions-config', { session: sid });
    await page.locator('#v3-config-form [name="retry"]').selectOption('manual');
    await page.locator('[data-v3-save="next"]').click();
    await page.waitForTimeout(3300);
    assert.equal(await page.evaluate((id) => window.ThreadTermPrototype.stateOf(window.ThreadTermPrototype.sessionById(id)), sid), 'failed');
    await act(page, 'sessions-config', { session: sid });
    await expect(page.locator('[data-testid="sessions-retry-history"]')).toContainText('取消待执行运行');
  });

  await scenario('configuration-restart-requires-confirmation', async (page) => {
    const sid = await create(page);
    const command = await page.evaluate((id) => window.ThreadTermPrototype.sessionById(id).command, sid);
    await act(page, 'sessions-config', { session: sid });
    await page.locator('#v3-config-form [name="startup"]').fill('codex resume checked');
    await page.locator('[data-v3-save="restart"]').click();
    await expect(page.locator('.dialog')).toContainText('当前运行和未完成回复会被中断');
    assert.equal(await page.evaluate((id) => window.ThreadTermPrototype.sessionById(id).command, sid), command);
    await act(page, 'sessions-config-confirm');
    assert.equal(await page.evaluate((id) => window.ThreadTermPrototype.sessionById(id).command, sid), 'codex resume checked');
  });

  await scenario('notification-reading-does-not-approve-chat-tool', async (page) => {
    const sid = await create(page, { mode: 'chat' });
    await page.locator('[data-v3-chat-form] textarea').fill('Read the demo configuration');
    await page.locator('[data-v3-chat-form] button[type="submit"]').click();
    await expect(page.locator('.v3-tool-card.pending')).toBeVisible();
    await act(page, 'open-notifications');
    const notification = page.locator('[data-action="notif-open"]').filter({ hasText: '需要批准模拟工具请求' });
    const episode = await notification.getAttribute('data-episode');
    await notification.click();
    assert.equal(await page.evaluate((id) => window.ThreadTermPrototype.store.featureStates.sessions.chats[id].tool.status, sid), 'pending');
    await act(page, 'attention-view', { episode });
    await expect(page.locator('.dialog')).toContainText('需要批准模拟工具请求');
    await act(page, 'attention-open', { session: sid });
    await act(page, 'sessions-tool', { session: sid, choice: 'approve' });
    const resolved = await page.evaluate((id) => { const api = window.ThreadTermPrototype; return api.store.resolved.includes(api.store.featureStates.sessions.chats[id].tool.attentionId); }, sid);
    assert.equal(resolved, true);
  });

  await scenario('chat-stream-does-not-replace-editor-or-draft', async (page) => {
    await create(page, { mode: 'chat' });
    await page.locator('[data-v3-chat-form] textarea').fill('Describe each change in the demo configuration and give a long review.');
    await page.locator('[data-v3-chat-form] button[type="submit"]').click();
    await act(page, 'ws-tab', { tab: 'file' });
    const editor = page.locator('[data-testid="codemirror-editor"] .cm-content');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n// survives chat completion');
    await page.waitForTimeout(1700);
    await expect(editor).toContainText('survives chat completion');
    await expect(editor).toBeFocused();
    await page.keyboard.insertText(' and keeps typing');
    await expect(editor).toContainText('survives chat completion and keeps typing');
  });

  await scenario('ime-composition-defers-chat-completion-render', async (page) => {
    await create(page, { mode: 'chat' });
    await page.locator('[data-v3-chat-form] textarea').fill('Review this task while I continue editing.');
    await page.locator('[data-v3-chat-form] button[type="submit"]').click();
    await act(page, 'ws-tab', { tab: 'file' });
    const editor = page.locator('[data-testid="codemirror-editor"] .cm-content');
    await editor.click();
    await page.keyboard.press('Control+End');
    // Synthetic composition events test the DOM lifetime fence; no claim of native OS IME automation.
    const original = await editor.elementHandle();
    await editor.dispatchEvent('compositionstart', { data: '' });
    await page.keyboard.insertText('\n// 中文输入未被中断');
    await page.waitForTimeout(1700);
    assert.equal(await original.evaluate((node) => node.isConnected), true);
    await expect(editor).toBeFocused();
    await expect(editor).toContainText('中文输入未被中断');
    await editor.dispatchEvent('compositionend', { data: '中文输入未被中断' });
    await expect.poll(() => original.evaluate((node) => node.isConnected)).toBe(false);
    await expect(editor).toContainText('中文输入未被中断');
    await expect(editor).toBeFocused();
    await page.keyboard.insertText('，继续编辑');
    await expect(editor).toContainText('中文输入未被中断，继续编辑');
    await original.dispose();
  });

  await scenario('reading-old-terminal-output-retains-position-and-exact-unread-count', async (page) => {
    const sid = await create(page);
    await act(page, 'session-menu', { session: sid });
    await act(page, 'sessions-output-demo', { session: sid });
    const log = page.locator(`[data-session-log="${sid}"]`);
    await log.hover();
    await page.mouse.wheel(0, -8000);
    await expect.poll(() => log.evaluate((node) => node.scrollTop)).toBe(0);
    await act(page, 'session-menu', { session: sid });
    await act(page, 'sessions-output-demo', { session: sid });
    assert.equal(await log.evaluate((node) => node.scrollTop), 0);
    await expect(page.locator('[data-action="sessions-log-bottom"]')).toContainText('40 条新输出');
    await act(page, 'sessions-log-bottom', { session: sid });
    await expect.poll(() => log.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(2);
    await expect(page.locator('[data-action="sessions-log-bottom"]')).toHaveCount(0);
  });

  await scenario('end-failure-timeout-keeps-session-and-force-end-retains-draft', async (page) => {
    const sid = await create(page);
    await act(page, 'ws-tab', { tab: 'file' });
    const editor = page.locator('[data-testid="codemirror-editor"] .cm-content');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n// draft survives forced termination');
    await act(page, 'ws-tab', { tab: 'terminal' });
    for (const outcome of ['failure', 'timeout']) {
      await act(page, 'end-session', { session: sid });
      await page.locator('#v3-end-outcome').selectOption(outcome);
      await act(page, 'sessions-end-confirm', { session: sid });
      await expect(page.locator('.dialog')).toContainText('已保留会话');
      assert.equal(await page.evaluate((id) => window.ThreadTermPrototype.isEnded(window.ThreadTermPrototype.sessionById(id)), sid), false);
      if (outcome === 'timeout') {
        await act(page, 'sessions-end-wait', { session: sid });
        await expect(page.locator('[data-testid="session-end-status"]')).toContainText('仍未收到');
      }
      await act(page, 'sessions-end-keep');
      await expect(page.locator(`[data-testid="session-controls-${sid}"]`)).toBeVisible();
    }
    await act(page, 'end-session', { session: sid });
    await page.locator('#v3-end-outcome').selectOption('timeout');
    await act(page, 'sessions-end-confirm', { session: sid });
    await act(page, 'sessions-end-force', { session: sid });
    assert.equal(await page.evaluate((id) => window.ThreadTermPrototype.isEnded(window.ThreadTermPrototype.sessionById(id)), sid), true);
    await act(page, 'ws-tab', { tab: 'file' });
    await expect(editor).toContainText('draft survives forced termination');
    await page.reload();
    await expect(editor).toContainText('draft survives forced termination');
  });

  await scenario('reset-visible-confirmation-preserves-source', async (page) => {
    const sentinel = JSON.stringify({ source: 'kept' });
    await page.evaluate((value) => localStorage.setItem('threadterm.app.v1', value), sentinel);
    await create(page, { mode: 'chat' });
    await act(page, 'open-scenarios');
    await act(page, 'sessions-reset-open');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('[data-v3-chat-form]')).toBeVisible();
    await act(page, 'open-scenarios');
    await act(page, 'sessions-reset-open');
    await act(page, 'sessions-reset-confirm');
    await expect(page.getByRole('button', { name: '开始体验', exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => localStorage.getItem('threadterm.app.v1')), sentinel);
    assert.equal(await page.evaluate(() => window.ThreadTermPrototype.store.userSessions.length), 0);
  });
} finally {
  await harness.finish('session-workflows-results.json');
}
