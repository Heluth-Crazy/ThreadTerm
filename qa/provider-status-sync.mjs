// Desktop-1 production-renderer regression QA for stale provider snapshot propagation.
// No runtime or provider executable is launched: the bridge is a page-init fixture.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { electron } from './lib/desktop1.mjs';
import { startReadonlyReferenceServer } from './parity/reference-server.mjs';

process.env.TT_QA_DESKTOP = '1';
const root = resolve(import.meta.dirname, '..');
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }; const baseline = process.argv.includes('--expect-stale');
const rendererRoot = resolve(option('--renderer-root') ?? join(root, 'desktop-dist', 'renderer'));
const out = resolve(option('--out') ?? join(root, 'qa', 'results', 'provider-status-sync'));
const profile = await mkdtemp(join(tmpdir(), 'tt-provider-status-'));
const report = { passed: false, calls: [], screenshots: [] };
const server = await startReadonlyReferenceServer(rendererRoot);
const app = await electron.launch({
  args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(root, 'qa', 'parity', 'electron-static.cjs')],
  env: Object.fromEntries(Object.entries({ ...process.env, TT_PARITY_PROFILE: profile }).filter(([key]) => key.toUpperCase() !== 'PATH')),
  timeout: 30_000,
});
try {
  await mkdir(out, { recursive: true });
  const page = await app.firstWindow({ timeout: 30_000 }); page.setDefaultTimeout(5_000); page.on('pageerror', error => { (report.pageErrors ??= []).push(String(error)); });
  await page.addInitScript(() => {
    const staleCodex = { id: 'codex', name: 'Codex', installed: false, terminal: true, chat: false, history: false, resume: false, auth: 'unknown', reason: 'not installed' };
    const freshCodex = { ...staleCodex, installed: true, chat: true, history: true, resume: true, auth: 'signed_in', version: 'fixture', reason: undefined };
    const project = { id: 'provider-status-project', name: 'Provider status QA', path: 'C:/qa/provider-status', createdAt: '2026-10-08T00:00:00.000Z' };
    const settings = { revision: 1, language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false }, terminalCompatibility: { aiCompletionHints: false }, customThemes: {} };
    let available = false; let providerCache = [staleCodex]; const snapshot = () => ({ epoch: 'provider-status-fixture', revision: 1, projects: [project], sessions: [], inbox: [], providers: providerCache, settings, workspaces: [], presets: [] });
    const calls = []; window.__providerStatusQA = { calls, setAvailable: () => { available = true; } };
    const emit = () => listeners.forEach(listener => listener({ v: 1, event: 'state.changed', epoch: 'provider-status-fixture', seq: calls.length, data: { kind: 'provider' } }));
    const listeners = new Set();
    window.threadterm = { platform: 'win32', request: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'runtime.snapshot') { calls.at(-1).installed = providerCache[0].installed; return structuredClone(snapshot()); }
      if (method === 'provider.list') { const next = available ? freshCodex : staleCodex; providerCache = [next]; return [structuredClone(next)]; }
      if (method === 'settings.update') { Object.assign(settings, params.patch); settings.revision++; emit(); return structuredClone(settings); }
      if (method === 'worktree.list') return [{ id: 'main', projectId: project.id, path: project.path, branch: 'main', isMain: true, locked: false, missing: false }];
      if (method === 'project.catalog.list') return [{ ...project, pinned: false, sortOrder: 0, git: { available: true, branch: 'main' } }];
      if (method === 'catalog.visibility.list' || method === 'draft.list') return [];
      if (method === 'session.create') return { id: 'provider-status-created', projectId: project.id, worktreePath: project.path, provider: params.provider, mode: params.mode, title: params.title ?? '', status: 'starting', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      if (method === 'session.present' || method === 'session.claim' || method === 'session.release') return null;
      if (method === 'data.status') return { root: 'C:/qa', database: { path: 'C:/qa/test.db', sizeBytes: 0 }, counts: { projects: 1, sessions: 0, workspaces: 0, presets: 0, drafts: 0, usageRecords: 0 }, relocation: { state: 'idle' } };
      if (method === 'data.relocation.status') return { state: 'idle' };
      if (method === 'device.list') return [];
      if (method === 'device.status') return { enabled: false };
      if (method === 'plugin.list') return { plugins: [] };
      return null;
    }, onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); }, onDesktopNavigate() { return () => {}; }, chooseDirectory: async () => null, chooseSavePath: async () => null, openDirectory: async () => {}, openExternal: async () => {}, windowAction: async () => {}, openWindow: async () => {}, desktopPreferences: async () => ({ shortcuts: {} }), scheduleElectronCacheCleanup: async () => ({ scheduled: false }), exportDiagnostics: async () => null, testNotification: async () => ({ sent: false }), subscribeOutput: async () => () => {} };
  });
  await page.goto(server.origin + '/'); await page.waitForFunction(() => Boolean(window.threadterm)); await page.screenshot({ path: join(out, 'initial.png') });
  // Start with an unavailable provider, then change backend truth without a state.changed event.
  await page.locator('.side-foot .user-row').click();
  await page.locator('.shell-menu-foot').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: /Tools/i }).click();
  await page.locator('details.settings-tool-accounts > summary').click();
  await page.waitForFunction(() => window.__providerStatusQA.calls.some(call => call.method === 'provider.list'));
  await page.getByText('Codex', { exact: true }).waitFor();
  const account = page.locator('.settings-table article').filter({ has: page.getByText('Codex', { exact: true }) });
  await account.getByText(/Not installed/).waitFor();
  await page.evaluate(() => window.__providerStatusQA.setAvailable());
  const providerCallsBeforeRefresh = await page.evaluate(() => window.__providerStatusQA.calls.filter(call => call.method === 'provider.list').length);
  const snapshotsBeforeRefresh = await page.evaluate(() => window.__providerStatusQA.calls.filter(call => call.method === 'runtime.snapshot').length);
  await page.getByRole('button', { name: 'Refresh provider status', exact: true }).click();
  await page.waitForFunction(before => window.__providerStatusQA.calls.filter(call => call.method === 'provider.list').length === before + 1, providerCallsBeforeRefresh);
  assert.equal(await page.evaluate(() => window.__providerStatusQA.calls.filter(call => call.method === 'provider.list').length), providerCallsBeforeRefresh + 1, 'provider refresh loop');
  await account.getByText(/Installed.*fixture/).waitFor();
  await account.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, 'settings-installed.png') }); report.screenshots.push('settings-installed.png');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.locator('button.nav-item.new').click();
  const codex = page.getByRole('button', { name: /Codex/i }).filter({ hasText: 'Codex' });
  report.calls = await page.evaluate(() => window.__providerStatusQA.calls);
  if (baseline) { assert.equal(await codex.isEnabled(), false, 'old renderer unexpectedly propagated fresh Codex'); assert.equal(report.calls.some(call => call.method === 'runtime.snapshot' && call.installed), false, 'baseline unexpectedly refreshed global provider state'); await page.screenshot({ path: join(out, 'create-stale.png') }); report.screenshots.push('create-stale.png'); report.baseline = 'old renderer keeps Codex disabled after fresh provider.list'; report.passed = true; } else {
  await assert.doesNotReject(() => codex.isEnabled().then(enabled => assert.equal(enabled, true, 'fresh Codex capability did not reach Create')));
  assert.equal(await page.evaluate(() => window.__providerStatusQA.calls.filter(call => call.method === 'runtime.snapshot').length), snapshotsBeforeRefresh + 1, 'refresh must synchronize exactly one global snapshot');
  await codex.click();
  const chat = page.getByRole('button', { name: 'Chat', exact: true });
  assert.equal(await chat.isEnabled(), true, 'fresh Codex chat capability did not reach Create'); await chat.click();
  for (const [language, theme, width] of [['en', 'light', 1280], ['en', 'dark', 420], ['zh-CN', 'light', 1280], ['zh-CN', 'dark', 420]]) {
    await page.evaluate(({ language, theme }) => window.threadterm.request('settings.update', { patch: { language, theme }, expectedRevision: 1, operationId: crypto.randomUUID() }), { language, theme });
    await page.waitForFunction(({ theme, language }) => document.documentElement.dataset.theme === theme && document.querySelector('.create-dlg h2')?.textContent.includes(language === 'en' ? 'New terminal' : '新建终端'), { theme, language });
    await app.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(width, 900); return win.getContentSize(); }, width); await page.setViewportSize({ width, height: 900 }); const name = `create-${language}-${theme}-${width}.png`; await page.screenshot({ path: join(out, name) }); report.screenshots.push(name);
  }
  report.calls = await page.evaluate(() => window.__providerStatusQA.calls);
  assert.deepEqual(report.pageErrors ?? [], [], 'renderer page error');
  await page.getByRole('button', { name: /Create|创建/, exact: true }).click();
  await page.waitForFunction(() => window.__providerStatusQA.calls.filter(call => call.method === 'session.create').length === 1);
  assert.deepEqual(report.pageErrors ?? [], [], 'renderer page error'); report.calls = await page.evaluate(() => window.__providerStatusQA.calls);
  const creates = report.calls.filter(call => call.method === 'session.create'); assert.equal(creates.length, 1, 'Create must call session.create exactly once'); assert.deepEqual({ provider: creates[0].params.provider, mode: creates[0].params.mode }, { provider: 'codex', mode: 'chat' });
  report.passed = true;
  }
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally { await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); await app.close().catch(() => {}); await server.close(); console.log(JSON.stringify(report)); }
