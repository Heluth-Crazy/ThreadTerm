// Production renderer QA for empty provider snapshots and later capability updates.
// The page-init bridge is synthetic; no provider executable or model request is run.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { electron } from './lib/desktop1.mjs';
import { startReadonlyReferenceServer } from './parity/reference-server.mjs';

process.env.TT_QA_DESKTOP = '1';
const root = resolve(import.meta.dirname, '..');
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const rendererRoot = resolve(option('--renderer-root') ?? join(root, 'desktop-dist', 'renderer'));
const out = resolve(option('--out') ?? join(root, 'qa', 'results', 'provider-pending-detection'));
const scratch = await mkdtemp(join(tmpdir(), 'tt-provider-pending-'));
const profile = join(scratch, 'electron-profile');
const isolatedHome = join(scratch, 'home');
const isolatedCodexHome = join(isolatedHome, '.codex');
const isolatedAppData = join(scratch, 'appdata');
const isolatedLocalAppData = join(scratch, 'localappdata');
const isolatedData = join(scratch, 'data');
const isolatedUserData = join(scratch, 'user-data');
const isolatedPipe = `\\\\.\\pipe\\threadterm-pending-${randomUUID()}`;
const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|home|userprofile|homedrive|homepath|codex_home|appdata|localappdata|threadterm_v3_.*|tt_qa_.*|tt_parity_profile|electron_run_as_node)$/i.test(key)));
Object.assign(childEnv, {
  Path: [dirname(process.execPath), join(systemRoot, 'System32')].join(';'),
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  HOMEDRIVE: isolatedHome.slice(0, 2),
  HOMEPATH: isolatedHome.slice(2),
  CODEX_HOME: isolatedCodexHome,
  APPDATA: isolatedAppData,
  LOCALAPPDATA: isolatedLocalAppData,
  THREADTERM_V3_DATA: isolatedData,
  THREADTERM_V3_USER_DATA: isolatedUserData,
  THREADTERM_V3_PIPE: isolatedPipe,
  TT_QA_DESKTOP: '1',
  TT_PARITY_PROFILE: profile,
});
const report = { passed: false, pageErrors: [], screenshots: [] };
let server;
let app;
let page;
try {
  await Promise.all([profile, isolatedHome, isolatedCodexHome, isolatedAppData, isolatedLocalAppData, isolatedData, isolatedUserData].map(path => mkdir(path, { recursive: true })));
  server = await startReadonlyReferenceServer(rendererRoot);
  app = await electron.launch({
    args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(root, 'qa', 'parity', 'electron-static.cjs')],
    env: childEnv,
    timeout: 30_000,
  });
  await mkdir(out, { recursive: true });
  page = await app.firstWindow({ timeout: 30_000 }); page.setDefaultTimeout(5_000); page.on('pageerror', error => report.pageErrors.push(String(error)));
  await page.addInitScript(() => {
    const projects = [
      { id: 'provider-pending-one', name: 'First project', path: 'C:/qa/first', createdAt: '2026-10-11T00:00:00.000Z' },
      { id: 'provider-pending-two', name: 'Second project', path: 'C:/qa/second', createdAt: '2026-10-11T00:00:00.000Z' },
    ];
    const settings = { revision: 1, language: 'zh-CN', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false }, terminalCompatibility: { aiCompletionHints: false }, customThemes: {} };
    let providerCache = [];
    const calls = []; const listeners = new Set(); let providerListFails = false; let eventSeq = 0;
    let refreshGeneration = 0; let refreshOutcome = 'ok'; let refreshRequestFails = false;
    const emit = () => listeners.forEach(listener => listener({ v: 1, event: 'state.changed', epoch: 'provider-pending-fixture', seq: ++eventSeq, data: { kind: 'providers' } }));
    const snapshot = () => ({ epoch: 'provider-pending-fixture', revision: 1, projects, sessions: [], inbox: [], providers: providerCache, settings, workspaces: [] });
    // `provider.refresh` answers with a generation and publishes its completion later, exactly like the runtime
    // (runtime/src/service.rs set_capability_listener): the same event shape carries outcome ok or failed.
    const emitRefresh = () => listeners.forEach(listener => listener({ v: 1, event: 'state.changed', epoch: 'provider-pending-fixture', seq: ++eventSeq, data: { kind: 'providers', generation: refreshGeneration, outcome: refreshOutcome } }));
    window.__providerPendingQA = { calls, setProviders: next => { providerCache = next; emit(); }, setProviderListFails: value => { providerListFails = value; }, setRefreshOutcome: value => { refreshOutcome = value; }, setRefreshRequestFails: value => { refreshRequestFails = value; }, setPresentation: (language, theme) => { settings.language = language; settings.theme = theme; emit(); }, emitStateChanged: emit };
    window.threadterm = { platform: 'win32', request: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'runtime.snapshot') return structuredClone(snapshot());
      if (method === 'provider.list') { if (providerListFails) throw new Error('provider detection unavailable'); return structuredClone(providerCache); }
      if (method === 'provider.refresh') { if (refreshRequestFails) throw new Error('provider refresh unavailable'); refreshGeneration += 1; const generation = refreshGeneration; queueMicrotask(() => { if (generation === refreshGeneration) emitRefresh(); }); return { refreshId: generation }; }
      if (method === 'worktree.list') return [{ id: 'first-main', projectId: projects[0].id, path: projects[0].path, branch: 'main', isMain: true, locked: false, missing: false }];
      if (method === 'project.catalog.list') return projects.map(project => ({ ...project, pinned: false, sortOrder: 0, git: { available: true, branch: 'main' } }));
      if (method === 'catalog.visibility.list' || method === 'draft.list') return [];
      if (method === 'settings.update') { Object.assign(settings, params.patch); settings.revision++; emit(); return structuredClone(settings); }
      if (method === 'data.status') return { root: 'C:/qa', database: { path: 'C:/qa/test.db', sizeBytes: 0 }, counts: { projects: projects.length, sessions: 0, workspaces: 0, drafts: 0, usageRecords: 0 }, relocation: { state: 'idle' } };
      if (method === 'data.relocation.status') return { state: 'idle' };
      if (method === 'device.list') return [];
      if (method === 'device.status') return { enabled: false };
      if (method === 'plugin.list') return { plugins: [] };
      return null;
    }, onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); }, onDesktopNavigate() { return () => {}; }, chooseDirectory: async () => null, chooseSavePath: async () => null, openDirectory: async () => {}, openExternal: async () => {}, windowAction: async () => {}, openWindow: async () => {}, desktopPreferences: async () => ({ shortcuts: {} }), scheduleElectronCacheCleanup: async () => ({ scheduled: false }), exportDiagnostics: async () => null, testNotification: async () => ({ sent: false }), subscribeOutput: async () => () => {} };
  });
  await page.goto(server.origin + '/'); await page.waitForFunction(() => Boolean(window.threadterm));

  await page.locator('.side-foot .user-row').click();
  await page.locator('.shell-menu-foot').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: /智能体/ }).click();
  await page.locator('[data-testid="agents-settings"]').waitFor();
  await page.getByText('正在检测智能体…', { exact: true }).waitFor();
  const countCalls = method => page.evaluate(method => window.__providerPendingQA.calls.filter(call => call.method === method).length, method);
  const assertAppAvailable = async () => {
    assert.equal(await page.getByText(/Runtime unavailable|运行时不可用/).count(), 0, 'provider failure must not replace the app with a runtime failure');
    assert.equal(await page.getByRole('button', { name: /Retry connection|重新连接/ }).count(), 0, 'provider failure must not expose global Retry');
    assert.equal(await page.locator('.project-catalog').isVisible(), true, 'project catalog remains visible through provider failure');
  };
  const initialProviderChecks = await countCalls('provider.list');
  assert.ok(initialProviderChecks >= 1, 'empty snapshot starts an automatic provider check');
  await page.evaluate(() => { window.__providerPendingQA.setProviderListFails(true); window.__providerPendingQA.emitStateChanged(); });
  const account = page.locator('[data-testid="agents-settings"]');
  await account.getByRole('alert').getByText(/智能体检测失败/).waitFor();
  await assertAppAvailable();
  await account.getByRole('alert').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, 'settings-detection-failed-zh.png') }); report.screenshots.push('settings-detection-failed-zh.png');
  assert.ok(await countCalls('runtime.snapshot') >= 2, 'provider notification refreshes the runtime snapshot successfully');
  const failedSnapshotChecks = await countCalls('provider.list');
  assert.equal(failedSnapshotChecks, initialProviderChecks + 1, 'new empty snapshot reference retries provider detection once');
  await page.evaluate(() => window.__providerPendingQA.emitStateChanged());
  await page.waitForFunction(expected => window.__providerPendingQA.calls.filter(call => call.method === 'provider.list').length === expected, failedSnapshotChecks + 1);
  await page.evaluate(() => window.__providerPendingQA.emitStateChanged());
  await page.waitForFunction(expected => window.__providerPendingQA.calls.filter(call => call.method === 'provider.list').length === expected, failedSnapshotChecks + 2);
  const afterRepeatedEvents = await countCalls('provider.list');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await countCalls('provider.list'), afterRepeatedEvents, 'failed automatic checks do not trigger a parent refresh loop');
  await page.evaluate(() => { window.__providerPendingQA.setProviderListFails(false); window.__providerPendingQA.setProviders([{ id: 'codex', name: 'Codex', installed: false, terminal: false, chat: false, history: false, resume: false, auth: 'unknown', reason: 'not installed' }]); });
  await page.locator('[data-agent-row="codex"][data-agent-state="missing"]').waitFor();
  await account.getByRole('alert').waitFor({ state: 'detached' });
  await page.evaluate(() => window.__providerPendingQA.setProviders([{ id: 'codex', name: 'Codex', installed: false, terminal: false, chat: false, history: false, resume: false, auth: 'unknown', reason: 'not installed' }]));
  await page.locator('[data-agent-row="codex"][data-agent-state="missing"]').waitFor();
  await page.screenshot({ path: join(out, 'settings-confirmed-missing-zh.png') }); report.screenshots.push('settings-confirmed-missing-zh.png');
  // A Check that cannot even be sent changes no global state: nothing was refreshed, so nothing may be re-read.
  const snapshotsBeforeCheck = await countCalls('runtime.snapshot');
  await page.evaluate(() => window.__providerPendingQA.setRefreshRequestFails(true));
  await page.locator('[data-testid="agents-check"] button').click();
  await account.getByRole('alert').getByText(/提供者状态|Provider status/).waitFor().catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await countCalls('runtime.snapshot'), snapshotsBeforeCheck, 'a Check whose request failed does not refresh the parent snapshot');
  await page.evaluate(() => window.__providerPendingQA.setRefreshRequestFails(false));
  // A round that completes as failed does publish its completion, so the snapshot is re-read exactly once and the
  // row keeps the last known values instead of claiming a fresh detection.
  await page.evaluate(() => window.__providerPendingQA.setRefreshOutcome('failed'));
  await page.locator('[data-testid="agents-check"] button').click();
  await page.waitForFunction(expected => window.__providerPendingQA.calls.filter(call => call.method === 'runtime.snapshot').length === expected, snapshotsBeforeCheck + 1);
  await page.getByText('无法刷新提供商状态，正在显示上次检测结果。', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-agent-row="codex"]').getAttribute('data-agent-state'), 'missing', 'a failed round keeps the row it already showed');
  // A successful Check refreshes the snapshot exactly once.
  const snapshotsBeforeOk = await countCalls('runtime.snapshot');
  await page.evaluate(() => window.__providerPendingQA.setRefreshOutcome('ok'));
  await page.locator('[data-testid="agents-check"] button').click();
  await page.waitForFunction(expected => window.__providerPendingQA.calls.filter(call => call.method === 'runtime.snapshot').length === expected, snapshotsBeforeOk + 1);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await countCalls('runtime.snapshot'), snapshotsBeforeOk + 1, 'a successful Check refreshes the parent snapshot exactly once');
  assert.equal(await page.evaluate(() => window.__providerPendingQA.calls.filter(call => call.method === 'provider.refresh').length), 3, 'one Check sends one refresh');
  await page.evaluate(() => window.__providerPendingQA.setProviders([]));
  await account.getByText('正在检测智能体…', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭设置' }).click();

  await page.locator('button.nav-item.new').click();
  await page.getByText('正在检测提供商…', { exact: true }).waitFor();
  const codexAction = page.getByRole('button', { name: /Codex/ }).filter({ hasText: 'Codex' });
  assert.equal(await codexAction.isEnabled(), false, 'native provider action must remain disabled during empty-snapshot detection');
  // A preset terminal needs no detected provider, so choosing it keeps Create usable while detection runs.
  await page.getByRole('button', { name: '预设', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /创建/ }).isEnabled(), true, 'preset creation remains available while providers are detected');
  await page.getByRole('button', { name: '预设', exact: true }).click();
  await page.getByLabel('名称').fill('保留的会话名称');
  const createComboboxes = page.locator('.create-form [role="combobox"]');
  const projectSelect = createComboboxes.nth(0);
  await projectSelect.click();
  await page.getByRole('option', { name: /Second project/ }).click();
  const presetSelect = createComboboxes.nth(2);
  await presetSelect.click();
  await page.getByRole('option', { name: '自定义', exact: true }).click();
  await page.getByLabel('初始命令').fill('node keep-this-argument.js --flag');
  await page.evaluate(() => { window.__providerPendingQA.setProviderListFails(true); window.__providerPendingQA.emitStateChanged(); });
  await page.getByRole('dialog').getByRole('alert').getByText('提供商检测失败。', { exact: true }).waitFor();
  await assertAppAvailable();
  assert.equal(await codexAction.isEnabled(), false, 'failed discovery cannot enable a native provider');
  assert.equal(await page.getByRole('button', { name: /^创建$/ }).isEnabled(), true, 'custom creation remains available through failed provider discovery');
  assert.equal(await page.getByLabel('名称').inputValue(), '保留的会话名称');
  assert.equal(await page.getByLabel('初始命令').inputValue(), 'node keep-this-argument.js --flag');
  await page.screenshot({ path: join(out, 'create-detection-failed-zh.png') }); report.screenshots.push('create-detection-failed-zh.png');
  await page.evaluate(() => { window.__providerPendingQA.setProviderListFails(false); window.__providerPendingQA.emitStateChanged(); });
  await page.getByText('正在检测提供商…', { exact: true }).waitFor();
  await page.evaluate(() => window.__providerPendingQA.setProviders([{ id: 'codex', name: 'Codex', installed: true, terminal: true, chat: true, history: true, resume: true, auth: 'signed_in', version: 'fixture' }]));
  await page.getByRole('button', { name: /创建/ }).waitFor();
  await page.getByText('正在检测提供商…', { exact: true }).waitFor({ state: 'detached' });
  assert.equal(await codexAction.isEnabled(), true, 'installed capability reaches the open create dialog');
  assert.equal(await page.getByLabel('名称').inputValue(), '保留的会话名称', 'title remains unchanged across capability update');
  assert.equal(await projectSelect.getAttribute('data-value'), 'provider-pending-two', 'selected project remains unchanged across capability update');
  assert.equal(await presetSelect.getAttribute('data-value'), 'custom', 'custom preset remains unchanged across capability update');
  assert.equal(await page.getByLabel('初始命令').inputValue(), 'node keep-this-argument.js --flag', 'command arguments remain unchanged across capability update');
  assert.deepEqual(report.pageErrors, [], 'renderer page errors');
  await page.screenshot({ path: join(out, 'create-installed-preserves-form-zh.png') }); report.screenshots.push('create-installed-preserves-form-zh.png');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 760));
  await page.evaluate(() => { window.__providerPendingQA.setProviderListFails(true); window.__providerPendingQA.setProviders([]); window.__providerPendingQA.setPresentation('en', 'dark'); });
  await page.getByRole('dialog').getByRole('alert').getByText('Provider detection failed.', { exact: true }).waitFor();
  await assertAppAvailable();
  assert.equal(await page.getByRole('dialog').getByRole('button', { name: /^Create$/ }).isEnabled(), true);
  await page.screenshot({ path: join(out, 'create-detection-failed-en-dark-compact.png') }); report.screenshots.push('create-detection-failed-en-dark-compact.png');
  assert.deepEqual(report.pageErrors, [], 'failure and locale/theme/size transitions have no renderer errors');
  report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally { await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); await app?.close().catch(() => {}); await server?.close(); console.log(JSON.stringify(report)); }
