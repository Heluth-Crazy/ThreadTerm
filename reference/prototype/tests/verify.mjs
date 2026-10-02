import { expect } from '@playwright/test';
import { startHarness, enter, act, screenshot, assertHealthy, assert } from './harness.mjs';

const harness = await startHarness();
const only = process.env.PROTOTYPE_TEST || '';

async function scenario(name, callback) {
  if (only && !name.includes(only)) return;
  await harness.scenario(name, async () => {
    const session = await harness.newPage();
    const { page, context, errors, requests } = session;
    try {
      await enter(page, harness.origin);
      await callback(page, context);
      await assertHealthy(page, errors, requests);
    } catch (error) {
      await screenshot(page, `failure-${name}`).catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  });
}

async function create(page, { agent = 'Codex', mode = 'chat', name = 'QA session', tree } = {}) {
  await page.locator('[data-action="sessions-new"], [data-action="open-create"]').filter({ visible: true }).first().click();
  const form = page.locator('#v3-create-form');
  await expect(form).toBeVisible();
  await form.locator(`[data-create-agent="${agent}"]`).click();
  await form.locator(`[data-create-mode="${mode}"]`).click();
  if (tree) await form.locator('select[name="tree"]').selectOption(tree);
  await form.locator('input[name="name"]').fill(name);
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page).toHaveURL(/#\/workspace\//);
  const id = decodeURIComponent(page.url().split('/workspace/')[1]);
  if (mode === 'chat') await expect(page.locator(`[data-testid="session-chat-${id}"]`)).toBeVisible();
  else await expect(page.locator(`[data-terminal-form="${id}"]`)).toBeVisible();
  return id;
}

async function sendChat(page, prompt) {
  const form = page.locator('[data-v3-chat-form]').filter({ visible: true }).first();
  await form.locator('textarea').fill(prompt);
  await form.getByRole('button', { name: '发送', exact: true }).click();
}

async function settings(page, section = 'appearance') {
  await act(page, 'open-settings');
  await act(page, 'settings-open');
  await act(page, 'settings-section', { section });
}

async function editor(page) {
  await act(page, 'open-session', { session: 'orbit-claude' });
  await expect(page).toHaveURL(/#\/workspace\/orbit-claude$/);
  await act(page, 'ws-tab', { tab: 'file' });
  const content = page.locator('[data-testid="codemirror-editor"] .cm-content');
  await expect(content).toBeVisible();
  return content;
}

try {
  await scenario('source-storage-isolation', async (page) => {
    const sentinel = JSON.stringify({ theme: 'dark', welcomeSeen: true, userSessions: [], aliases: { sample: 'source' } });
    await page.evaluate((value) => localStorage.setItem('threadterm.app.v1', value), sentinel);
    await settings(page);
    await act(page, 'settings-theme', { theme: 'dark' });
    await act(page, 'settings-close');
    await create(page, { name: 'Isolated v3 session' });
    assert.equal(await page.evaluate(() => localStorage.getItem('threadterm.app.v1')), sentinel);
    await page.reload();
    await expect(page.locator('[data-testid^="session-chat-"]')).toBeVisible();
    assert.equal(await page.evaluate(() => localStorage.getItem('threadterm.app.v1')), sentinel);
    assert.ok(await page.evaluate(() => localStorage.getItem('threadterm.app.v3')));
  });

  for (const agent of ['Codex', 'Claude Code', 'Kimi', 'Gemini', 'OpenCode']) {
    for (const mode of ['terminal', 'chat']) {
      await scenario(`create-${agent.replaceAll(' ', '-')}-${mode}`, async (page) => {
        const id = await create(page, { agent, mode, name: `QA ${agent} ${mode}` });
        const stored = await page.evaluate((sid) => window.ThreadTermPrototype.sessions().find((item) => item.id === sid), id);
        assert.equal(stored.agent, agent);
        if (mode === 'chat') {
          await expect(page.locator(`[data-terminal-form="${id}"]`)).not.toBeVisible();
          await sendChat(page, `Review the ${agent} fixture`);
          await expect(page.locator('.v3-tool-card.pending')).toBeVisible();
          await act(page, 'sessions-tool', { session: id, choice: 'reject' });
          await expect(page.locator('.v3-tool-card.rejected')).toBeVisible();
        }
        await act(page, 'sessions-close-view', { session: id });
        await expect(page).toHaveURL(/#\/terminals$/);
        assert.equal(await page.evaluate((sid) => window.ThreadTermPrototype.isEnded(window.ThreadTermPrototype.sessionById(sid)), id), false);
        await act(page, 'open-session', { session: id });
        await expect(page).toHaveURL(new RegExp(`${id}$`));
      });
    }
  }

  await scenario('create-worktree-and-cancel', async (page) => {
    await act(page, 'open-tree', { tree: 'orbit-checkout' });
    const before = await page.evaluate(() => window.ThreadTermPrototype.sessions().length);
    await page.locator('main [data-action="sessions-new"], main [data-action="open-create"]').first().click();
    await expect(page.locator('#v3-create-form select[name="tree"]')).toHaveValue('orbit-checkout');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.evaluate(() => window.ThreadTermPrototype.sessions().length), before);
    const id = await create(page, { tree: 'orbit-checkout', name: 'Bound to checkout' });
    assert.equal(await page.evaluate((sid) => window.ThreadTermPrototype.sessionById(sid).tree, id), 'orbit-checkout');
  });

  await scenario('chat-approve-reject', async (page) => {
    const id = await create(page);
    await sendChat(page, 'Review the checkout code');
    await act(page, 'sessions-tool', { choice: 'approve' });
    await expect(page.locator('.v3-tool-card')).toHaveClass(/approved/);
    await sendChat(page, 'Review the next file');
    await act(page, 'sessions-tool', { choice: 'reject' });
    await expect(page.locator('.v3-tool-card')).toHaveClass(/rejected/);
    await expect(page.locator('[data-action="sessions-export-chat"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /下载 Markdown|下载 AI Markdown/ })).toHaveCount(0);
    await act(page, 'session-menu', { session: id });
    await expect(page.locator('[data-action="sessions-export-chat"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '下载 AI Markdown' })).toHaveCount(0);
  });

  await scenario('chat-stop-cancels-stream', async (page) => {
    await create(page);
    await sendChat(page, 'Explain the full implementation and every step in detail.');
    await expect(page.locator('.v3-chat-message.assistant')).toBeVisible();
    await act(page, 'sessions-chat-stop');
    const message = page.locator('.v3-chat-message.assistant').last();
    const stopped = await message.innerText();
    await page.waitForTimeout(1400);
    assert.equal(await message.innerText(), stopped, 'Stopped stream continued writing');
    await expect(page.locator('.v3-tool-card.pending')).toHaveCount(0);
  });

  await scenario('lifecycle-error-retry-and-config-cancel', async (page) => {
    const id = await create(page, { mode: 'terminal' });
    await act(page, 'sessions-config', { session: id });
    await page.locator('#v3-config-form textarea[name="startup"]').fill('node task.mjs');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await act(page, 'sessions-fail', { session: id });
    await expect(page.locator('[data-action="sessions-retry"]')).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-action="sessions-retry"]')).toBeVisible();
    await act(page, 'sessions-retry', { session: id });
    await expect.poll(() => page.evaluate((sid) => window.ThreadTermPrototype.stateOf(window.ThreadTermPrototype.sessionById(sid)), id), { timeout: 7000 }).toBe('running');
  });

  await scenario('editor-type-save-undo-theme-reload', async (page) => {
    let content = await editor(page);
    await content.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n// persistent prototype edit');
    await expect(content).toContainText('persistent prototype edit');
    await page.keyboard.press('Control+s');
    await settings(page);
    await act(page, 'settings-theme', { theme: 'dark' });
    await act(page, 'settings-close');
    content = page.locator('[data-testid="codemirror-editor"] .cm-content');
    await expect(content).toContainText('persistent prototype edit');
    await content.click();
    await page.keyboard.press('Control+z');
    await expect(content).not.toContainText('persistent prototype edit');
    await page.keyboard.press('Control+Shift+z');
    await expect(content).toContainText('persistent prototype edit');
    await page.keyboard.press('Control+s');
    await page.reload();
    await act(page, 'ws-tab', { tab: 'file' });
    await expect(page.locator('[data-testid="codemirror-editor"] .cm-content')).toContainText('persistent prototype edit');
  });

  await scenario('editor-dirty-close-cancel-discard', async (page) => {
    const content = await editor(page);
    await content.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n// discard marker');
    await act(page, 'editor-close');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(content).toContainText('discard marker');
    await act(page, 'editor-close');
    await act(page, 'editor-discard');
    await act(page, 'ws-tab', { tab: 'file' });
    await expect(page.locator('[data-testid="codemirror-editor"] .cm-content')).not.toContainText('discard marker');
  });

  await scenario('settings-theme-supervisor-language', async (page) => {
    await settings(page, 'controls');
    await expect(page.locator('[data-action="settings-supervisor"]')).not.toBeChecked();
    await act(page, 'settings-section', { section: 'appearance' });
    await act(page, 'settings-theme', { theme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('[data-action="settings-language"]').selectOption('en');
    await act(page, 'settings-close');
    await expect(page.locator('.sidebar')).toContainText('All terminals');
    await page.reload();
    await expect(page.locator('.sidebar')).toContainText('All terminals');
  });
} finally {
  await harness.finish();
}
