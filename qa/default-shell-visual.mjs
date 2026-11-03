// Real Electron coverage for Settings → Terminal → Default shell. The isolated
// PATH contains no provider CLI, and this creates Shell terminals only.
//
// $env:TEMP="$env:TEMP\\tt-qa-temp"; $env:TMP=$env:TEMP
// Set THREADTERM_V3_RUNTIME_BIN to the built worktree runtime executable.
// node qa/default-shell-visual.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildQaApp } from './lib/qa-app.mjs';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import xterm from '@xterm/xterm';

const root = resolve(import.meta.dirname, '..');
const base = resolve(process.env.TEMP ?? tmpdir());
assert.ok(process.env.THREADTERM_V3_RUNTIME_BIN, 'Set THREADTERM_V3_RUNTIME_BIN to the built worktree runtime executable');
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN);
const out = join(root, 'qa/results/default-shell-visual');
const scratch = await mkdtemp(join(base, 'tt-default-shell-visual-'));
const bin = join(scratch, 'provider-bin');
const project = join(scratch, 'project');
const data = join(scratch, 'data');
const profile = join(scratch, 'profile');
const pipe = `\\\\.\\pipe\\tt-default-shell-visual-${randomUUID()}`;
const report = { passed: false, checks: [], screenshots: [], errors: [] };
let app, page, daemon, releaseLock, qaApp;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const wait = async (probe, label, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await probe(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
};
const terminalText = async sessionId => {
  const output = await request('terminal.read', { sessionId, cursor: 0, limit: 65_536 });
  const terminal = new xterm.Terminal({ cols: 120, rows: 40, scrollback: 1000, allowProposedApi: true });
  try {
    await new Promise(done => terminal.write(Buffer.from(output.data, 'base64').toString('utf8'), done));
    const buffer = terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true).trim() ?? '').join('\n');
  } finally { terminal.dispose(); }
};
const terminalHasLine = async (sessionId, expression) => expression.test(await terminalText(sessionId));

function environment() {
  const blocked = new Set(['path', 'temp', 'tmp', 'home', 'userprofile', 'codex_home', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime', 'threadterm_v3_runtime_bin', 'threadterm_qa_provider_bin']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.has(key.toLowerCase())));
  Object.assign(env, {
    PATH: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    TEMP: base, TMP: base, HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'),
    THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: profile, THREADTERM_V3_PIPE: pipe,
    THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_RUNTIME_BIN: runtime, THREADTERM_QA_PROVIDER_BIN: bin,
  });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'isolated QA environment has one PATH');
  return env;
}

async function startRuntime() {
  daemon = spawn(runtime, [], { env: environment(), windowsHide: true, stdio: 'ignore' });
  await wait(async () => {
    try { return Boolean((await readFile(join(data, 'runtime.credential'), 'utf8')).trim()); } catch { return false; }
  }, 'runtime credential');
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(timeoutMs).then(() => { throw Error(`runtime did not exit within ${timeoutMs} ms`); }),
  ]);
}

async function openTerminalSettings(language) {
  const user = page.getByRole('button', { name: language === 'zh-CN' ? '本地用户' : 'Local user', exact: true });
  await user.click();
  await page.getByRole('button', { name: language === 'zh-CN' ? '设置' : 'Settings', exact: true }).click();
  await page.locator('.settings-panel').waitFor();
  await page.getByRole('tab', { name: language === 'zh-CN' ? '终端' : 'Terminal', exact: true }).click();
  await page.getByRole('combobox', { name: language === 'zh-CN' ? '默认 Shell' : 'Default shell', exact: true }).waitFor();
}

async function closeSettings() {
  await page.getByRole('button', { name: /Close settings|关闭设置/ }).click();
  await page.locator('.settings-panel').waitFor({ state: 'detached' });
}

async function screenshot(name) {
  await page.locator('.settings-scroll').evaluate(node => { node.scrollTop = 0; });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(out, name), animations: 'disabled', scale: 'css' });
  report.screenshots.push(name);
}

async function selectValue(control, value) {
  await control.click();
  await page.locator(`[role="option"][data-value="${value}"]`).click();
}

async function createShell(command, oneShot) {
  const before = new Set((await request('runtime.snapshot')).sessions.map(session => session.id));
  await page.locator('.nav-item.new').click();
  const dialog = page.getByTestId('session-create-dialog');
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Shell', exact: true }).click();
  const commandInput = dialog.locator('.create-block').filter({ hasText: 'Initial command' }).locator('input');
  await commandInput.fill(command);
  if (oneShot) await dialog.getByText('Run once', { exact: true }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  return await wait(async () => (await request('runtime.snapshot')).sessions.find(session => !before.has(session.id) && session.provider === 'shell' && session.mode === 'terminal'), 'created Shell session');
}

try {
  await Promise.all([mkdir(base, { recursive: true }), mkdir(out, { recursive: true }), mkdir(bin, { recursive: true }), mkdir(project, { recursive: true }), mkdir(data, { recursive: true })]);
  assert.ok(existsSync(runtime), `missing runtime: ${runtime}`);
  qaApp = await buildQaApp({ root, outDir: join(scratch, 'app') });
  releaseLock = await acquireElectronQaLock({ directory: base, timeoutMs: 40 * 60_000 });
  await startRuntime();
  app = await electron.launch({ args: [qaApp.appDir], cwd: root, env: environment(), timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.threadterm?.request));
  await page.locator('#boot-splash').waitFor({ state: 'detached' });

  let snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en', theme: 'light' }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await request('project.add', { path: project, name: 'Default shell visual QA', operationId: randomUUID() });
  await wait(async () => (await request('runtime.snapshot')).projects.some(item => item.path === project), 'project in renderer snapshot');

  await openTerminalSettings('en');
  const select = page.getByRole('combobox', { name: 'Default shell', exact: true });
  await select.click();
  assert.deepEqual(await page.getByRole('option').allTextContents(), (await request('terminal.host')).pwshAvailable ? ['Command Prompt', 'Windows PowerShell', 'PowerShell 7'] : ['Command Prompt', 'Windows PowerShell'], 'PowerShell 7 option follows runtime discovery');
  await page.keyboard.press('Escape');
  await selectValue(select, 'powershell');
  await wait(async () => (await request('runtime.snapshot')).settings.defaultShell === 'powershell', 'saved Windows PowerShell preference');
  await screenshot('default-shell-en-light-wide.png');
  check('English Terminal settings persist Windows PowerShell and list PowerShell 7 only when discovered');

  snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { theme: 'dark' }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await screenshot('default-shell-en-dark-wide.png');
  await closeSettings();

  const interactive = await createShell('Write-Output "DEFAULT-SHELL-INTERACTIVE:$env:OS"', false);
  const interactiveConfig = await request('session.config.read', { sessionId: interactive.id });
  assert.equal(interactiveConfig.executable, 'powershell.exe', 'interactive UI create selects Windows PowerShell');
  assert.deepEqual(interactiveConfig.args.slice(0, 3), ['-NoLogo', '-NoExit', '-Command'], 'interactive command uses PowerShell NoExit command form');
  await wait(() => terminalHasLine(interactive.id, /^DEFAULT-SHELL-INTERACTIVE:Windows_NT$/m), 'interactive initial command output');
  await request('session.stop', { sessionId: interactive.id, force: true, operationId: randomUUID() });

  const once = await createShell('Write-Output "DEFAULT-SHELL-ONCE:$env:OS"', true);
  const onceConfig = await request('session.config.read', { sessionId: once.id });
  assert.equal(onceConfig.executable, 'powershell.exe', 'Run once UI create selects Windows PowerShell');
  assert.deepEqual(onceConfig.args.slice(0, 2), ['-NoLogo', '-Command'], 'Run once uses PowerShell command form');
  await wait(() => terminalHasLine(once.id, /^DEFAULT-SHELL-ONCE:Windows_NT$/m), 'Run once command output');
  const exited = await wait(async () => (await request('runtime.snapshot')).sessions.find(session => session.id === once.id && session.status === 'exited'), 'Run once completion');
  assert.equal(exited.exitCode, 0, 'Run once exits successfully');
  check('UI Initial command uses PowerShell for interactive and Run once Shell terminals');

  snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'zh-CN' }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await wait(() => page.getByRole('button', { name: '本地用户', exact: true }).count(), 'Chinese renderer');
  await openTerminalSettings('zh-CN');
  assert.equal(await page.getByRole('combobox', { name: '默认 Shell', exact: true }).getAttribute('data-value'), 'powershell', 'Chinese control keeps the saved PowerShell choice');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(420, 640));
  await screenshot('default-shell-zh-dark-narrow.png');
  const scroll = await page.locator('.settings-scroll').evaluate(node => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
  assert.ok(scroll.scrollWidth <= scroll.clientWidth + 1, 'narrow Chinese Terminal settings have no horizontal overflow');
  check('Chinese dark narrow Terminal settings retain the choice without horizontal overflow');
  assert.deepEqual(report.errors, [], 'no renderer errors');
  report.passed = true;
} catch (error) {
  report.errors.push(error.stack ?? String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png'), animations: 'disabled' }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(error => report.errors.push(`Electron cleanup: ${error.message}`));
  if (daemon?.exitCode === null) {
    daemon.kill();
    await waitForExit(daemon).catch(() => {});
  }
  await releaseLock?.().catch(error => report.errors.push(`QA lock cleanup: ${error.message}`));
  await qaApp?.cleanup?.().catch(error => report.errors.push(`QA app cleanup: ${error.message}`));
  await rm(scratch, { recursive: true, force: true }).catch(error => report.errors.push(`scratch cleanup: ${error.message}`));
  console.log(report.passed && report.errors.length === 0 ? 'DEFAULT SHELL VISUAL QA PASSED' : `DEFAULT SHELL VISUAL QA FAILED\n${report.errors.join('\n')}`);
}
