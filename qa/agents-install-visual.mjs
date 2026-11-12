// Settings › Agents install flow, against the real debug runtime on an isolated profile.
//
// The provider bin is a scratch folder that holds the only CLIs this app can see
// (THREADTERM_QA_PROVIDER_BIN): a fake `npm.cmd` that "installs" Codex by writing a fake `codex.cmd`
// (version probe answers, auth check reports signed out), plus a fake `winget.cmd` for the Node.js
// scenario. Nothing is installed globally, nothing reaches the real npm/winget, and the user's
// profile, data folder and pipe are all inside the scratch directory.
//
// Scenarios: install succeeds (row turns into 登录, install terminal archived), install fails (one
// failure line with the exit code, terminal kept), and npm missing (row offers 安装 Node.js with the
// winget command, which is never run).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const out = join(root, 'qa/results/agents-install');
const scratch = await mkdtemp(join(tmpdir(), 'tt-agents-install-'));
const appDir = join(scratch, 'app');
const bin = join(scratch, 'bin');
const modeFile = join(scratch, 'npm-mode.txt');
const report = { passed: false, checks: [], screenshots: [], errors: [] };
let app; let page;

const delay = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 60_000) {
  const end = Date.now() + timeout; let error;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch (caught) { error = caught; }
    if (Date.now() > end) throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`);
    await delay(100);
  }
}

async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'agents-install-qa', version: '0.1.0', main: 'main.cjs' }));
}

// The fake CLI npm would install: version probe answers, every auth check says signed out.
const fakeCodex = [
  '@echo off',
  'if "%1"=="--version" (',
  '  echo codex-cli 9.9.9-qa',
  '  exit /b 0',
  ')',
  'if "%1"=="login" (',
  '  echo Not logged in',
  '  exit /b 1',
  ')',
  'exit /b 0',
  '',
].join('\r\n');

// The fake npm: reads the scenario's mode file, "installs" codex.cmd on success, fails on "fail".
const fakeNpm = `
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const bin = process.env.THREADTERM_QA_PROVIDER_BIN;
const mode = existsSync(${JSON.stringify(modeFile)}) ? readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim() : 'ok';
await new Promise(done => setTimeout(done, 1200));
if (mode === 'fail') {
  console.error('npm ERR! code EACCES');
  process.exit(1);
}
writeFileSync(join(bin, 'codex.cmd'), ${JSON.stringify(fakeCodex)});
// The npm global layout the runtime reads to report installSource npm (shim dir/node_modules/<pkg>).
mkdirSync(join(bin, 'node_modules', '@openai', 'codex'), { recursive: true });
writeFileSync(join(bin, 'node_modules', '@openai', 'codex', 'package.json'), JSON.stringify({ name: '@openai/codex', version: '9.9.9-qa' }));
console.log('added 1 package in 1s');
`;

// Only ever shown in the confirm popover; the probe never presses 运行 for this one.
const fakeWinget = `@echo off\r\necho winget is not run by QA\r\nexit /b 1\r\n`;

const LOCALES = [
  { theme: 'light', lang: 'zh', label: 'light-zh' },
  { theme: 'dark', lang: 'zh', label: 'dark-zh' },
  { theme: 'light', lang: 'en', label: 'light-en' },
  { theme: 'dark', lang: 'en', label: 'dark-en' },
];
const copy = {
  zh: {
    install: '安装', node: '安装 Node.js', run: '运行', cancel: '取消', signIn: '登录',
    installing: '正在安装…', failed: /安装失败（退出码 1）/,
    tab: /智能体/,
  },
  en: {
    install: 'Install', node: 'Install Node.js', run: 'Run', cancel: 'Cancel', signIn: 'Sign in',
    installing: 'Installing…', failed: /Install failed \(exit code 1\)/,
    tab: /Agents/,
  },
};

async function present(theme, lang) {
  const snapshot = await request('runtime.snapshot');
  const patch = { language: lang === 'zh' ? 'zh-CN' : 'en', theme, themeSelection: theme, notifications: { native: false, attention: false, completed: false, sound: false } };
  await request('settings.update', { patch, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
}
async function openAgents() {
  await page.locator('.side-foot .user-row').click();
  const settings = page.locator('.shell-menu-foot').getByRole('button', { name: /^(设置|Settings)$/ });
  await settings.click();
  await page.locator('.settings-panel').waitFor();
  await page.locator('.settings-layout nav [role="tab"]').nth(1).click();
  await page.locator('[data-testid="agents-settings"]').waitFor();
}
async function closeSettings() {
  if (await page.locator('.settings-panel').count()) {
    await page.getByRole('button', { name: /关闭设置|Close settings/ }).click();
    await page.locator('.settings-panel').waitFor({ state: 'detached' });
  }
}
const refresh = async () => {
  await page.locator('[data-testid="agents-check"] button').click();
  await until(() => page.locator('[data-testid="agents-check"] button').getAttribute('aria-busy').then(value => value !== 'true'), 'provider check to settle');
};
async function shot(name) {
  // Astryx's Item lays its end content out after the row commits; let it settle so a capture never shows a
  // half-painted row.
  await delay(300);
  await page.screenshot({ path: join(out, `${name}.png`) });
  report.screenshots.push(`${name}.png`);
}
const sessionByTitle = async title => (await request('runtime.snapshot')).sessions.filter(session => session.title === title).at(-1);
/** Every row as the DOM shows it: the state machine's output, for the report and for the waits. */
const rows = () => page.evaluate(() => [...document.querySelectorAll('[data-agent-row]')].map(row => ({
  id: row.dataset.agentRow,
  state: row.dataset.agentState,
  end: (row.querySelector('.agents-row-end')?.innerText ?? '').replace(/\s+/g, ' ').trim(),
  failure: (row.querySelector('.agents-failure')?.innerText ?? '').replace(/\s+/g, ' ').trim() || undefined,
})));
const settle = async (label, timeout = 90_000) => until(async () => {
  const codex = (await rows()).find(row => row.id === 'codex');
  return codex && codex.state !== 'installing' ? codex : undefined;
}, label, timeout);

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build the debug runtime into runtime/target-qa/debug first`);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await Promise.all([bin, join(scratch, 'workspace'), join(scratch, 'home'), join(scratch, 'appdata')].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(scratch, 'fake-npm.mjs'), fakeNpm);
  await writeFile(join(bin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${join(scratch, 'fake-npm.mjs')}" %*\r\n`);
  await writeFile(modeFile, 'ok');
  await buildApp();

  const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const dropped = /^(path|home|userprofile|appdata|localappdata|codex_home|threadterm_v3_.*|tt_qa_.*|tt_parity_profile|electron_run_as_node)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !dropped.test(key)));
  Object.assign(env, {
    Path: [bin, dirname(process.execPath), system32].join(';'),
    HOME: join(scratch, 'home'),
    USERPROFILE: join(scratch, 'home'),
    APPDATA: join(scratch, 'appdata'),
    LOCALAPPDATA: join(scratch, 'appdata'),
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_QA_PROVIDER_BIN: bin,
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-agents-install-${randomUUID()}`,
  });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'PATH isolation keeps exactly one spelling');
  for (const path of [env.THREADTERM_V3_DATA, env.THREADTERM_V3_USER_DATA, env.APPDATA]) await mkdir(path, { recursive: true });

  app = await electron.launch({ args: [appDir], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1180, 900));

  // ---- Scenario 1: npm installs Codex; the row turns into 登录 and the terminal is archived.
  await present('light', 'zh');
  await openAgents();
  await until(async () => (await page.locator('[data-agent-row="codex"]').count()) > 0, 'Codex row');
  await page.locator('[data-agent-row="codex"][data-agent-state="missing"]').waitFor();
  report.rowsAfterOpen = await rows();
  assert.equal(await page.locator('[data-testid="agent-install-codex"]').count(), 1, 'a missing agent with a recipe offers 安装');
  const zh = copy.zh;
  // The confirm shows the exact command before anything runs.
  for (const locale of LOCALES) {
    await present(locale.theme, locale.lang);
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, locale.theme);
    await page.locator('[data-testid="agent-install-codex"] button').click();
    const dialog = page.locator('[data-testid="agents-confirm"]');
    await dialog.waitFor();
    assert.equal(await page.locator('[data-testid="agents-confirm-command"]').innerText(), 'npm install -g @openai/codex');
    await shot(`confirm-install-${locale.label}`);
    await dialog.getByRole('button', { name: copy[locale.lang].cancel, exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    if (locale.theme === 'dark' && locale.lang === 'en') break;
  }
  await present('light', 'zh');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.locator('[data-testid="agent-install-codex"] button').click();
  await page.locator('[data-testid="agents-confirm"]').waitFor();
  await page.getByRole('button', { name: zh.run, exact: true }).click();
  await page.locator('[data-agent-row="codex"][data-agent-state="installing"]').waitFor();
  check('安装 → confirm shows npm install -g @openai/codex → 运行 → the row shows 正在安装…');
  await shot('installing-light-zh');
  const afterInstall = await settle('install to finish');
  report.rowsAfterInstall = await rows();
  assert.ok(existsSync(join(bin, 'codex.cmd')), 'the fake npm wrote the installed CLI into the provider bin');
  assert.equal(afterInstall.state, 'signed-out', `the installed agent is signed out: ${JSON.stringify(afterInstall)}`);
  assert.equal(await page.locator('[data-testid="agent-sign-in-codex"]').count(), 1, 'the installed, signed-out agent offers 登录');
  const installed = sessionByTitle('安装 Codex');
  assert.ok(installed, 'the install terminal exists');
  await until(async () => (await sessionByTitle('安装 Codex'))?.archived === true, 'install terminal archived', 30_000);
  check('the finished install terminal is archived, so the session list stays clean');
  await shot('installed-light-zh');
  await page.locator('[data-agent-row="codex"]').getByText('Codex', { exact: true }).click();
  await page.locator('[data-agent-row="codex"] dl.agents-detail').waitFor();
  const detail = await page.locator('[data-agent-row="codex"] dl.agents-detail').innerText();
  assert.match(detail, /npm/, 'expanded details name the install source');
  assert.match(detail, /codex\.cmd/i, 'expanded details show the resolved executable');
  await shot('installed-details-light-zh');
  await page.locator('[data-agent-row="codex"]').getByText('Codex', { exact: true }).click();
  await closeSettings();

  // ---- Scenario 2: npm fails; one failure line, the terminal stays.
  await writeFile(modeFile, 'fail');
  await unlink(join(bin, 'codex.cmd'));
  await openAgents();
  await refresh();
  await page.locator('[data-agent-row="codex"][data-agent-state="missing"]').waitFor();
  await page.locator('[data-testid="agent-install-codex"] button').click();
  await page.locator('[data-testid="agents-confirm"]').waitFor();
  await page.getByRole('button', { name: zh.run, exact: true }).click();
  await page.locator('[data-testid="agent-failed-codex"]').waitFor({ timeout: 90_000 });
  assert.match(await page.locator('[data-testid="agent-failed-codex"]').innerText(), zh.failed);
  assert.equal(await page.locator('[data-testid="agent-retry-codex"]').count(), 1, 'the failure line offers 重试');
  assert.equal(await page.locator('[data-testid="agent-failure-output-codex"]').count(), 1, 'the failure line offers 查看输出');
  check('a failing install shows one failure line with the exit code, 查看输出 and 重试');
  const failed = sessionByTitle('安装 Codex');
  assert.ok(failed, 'the failed install terminal is still there');
  assert.notEqual(failed.archived, true, 'a failed install terminal is kept for its output');
  await shot('failed-light-zh');
  await present('dark', 'en');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.locator('[data-testid="agents-confirm"]').waitFor({ state: 'detached' }).catch(() => {});
  await shot('failed-dark-en');
  // 忽略 drops the remembered failure: the row is an ordinary missing row again and the terminal stays.
  await page.locator('[data-testid="agent-dismiss-codex"] button').click();
  await page.locator('[data-testid="agent-failed-codex"]').waitFor({ state: 'detached' });
  await page.locator('[data-agent-row="codex"][data-agent-state="missing"]').waitFor();
  assert.equal(await page.locator('[data-testid="agent-install-codex"]').count(), 1, 'after 忽略 the row offers Install again');
  check('忽略 clears the failure line and leaves an ordinary missing row');
  await closeSettings();

  // ---- Scenario 3: no npm at all; the row asks for Node.js first and never runs it here.
  // A fresh profile: the remembered failure above would otherwise keep showing its own line, which is the
  // documented behaviour (the row stays failed until 重试 or 忽略).
  await rm(join(bin, 'codex.cmd'), { force: true });
  await rm(join(bin, 'npm.cmd'), { force: true });
  await writeFile(join(bin, 'winget.cmd'), fakeWinget);
  await app.close();
  await mkdir(join(scratch, 'profile-nonode'), { recursive: true });
  app = await electron.launch({ args: [appDir], cwd: bin, env: { ...env, THREADTERM_V3_USER_DATA: join(scratch, 'profile-nonode'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-agents-install-${randomUUID()}` }, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await present('light', 'zh');
  await openAgents();
  await page.locator('[data-agent-row="codex"][data-agent-state="node-missing"]').waitFor({ timeout: 90_000 });
  // Every row keeps the ordinary 安装 button; Node.js is said once in the summary and in the confirm.
  assert.equal(await page.locator('[data-testid="agent-node-codex"]').count(), 1, 'without npm the row still offers one primary action');
  assert.equal((await page.locator('[data-testid="agent-node-codex"] button').innerText()).trim(), '安装', 'the blocked row reads 安装 like every other row');
  assert.equal(await page.locator('[data-testid="agents-settings"]').getByText('安装 Node.js', { exact: true }).count(), 0, 'no row repeats an 安装 Node.js button');
  assert.match(await page.locator('.agents-summary').innerText(), /需要 Node\.js/, 'the summary says once that Node.js is needed');
  await page.locator('[data-testid="agent-node-codex"] button').click();
  await page.locator('[data-testid="agents-confirm"]').waitFor();
  assert.equal(await page.locator('[data-testid="agents-confirm"]').getAttribute('aria-label'), '先安装 Node.js');
  assert.equal(await page.locator('[data-testid="agents-confirm-command"]').innerText(), 'winget install --id OpenJS.NodeJS.LTS -e --source winget');
  check('without npm the row offers 安装, whose confirm is 先安装 Node.js with the exact winget command');
  await shot('node-missing-confirm-light-zh');
  await page.getByRole('button', { name: copy.zh.cancel, exact: true }).click();
  await page.locator('[data-testid="agents-confirm"]').waitFor({ state: 'detached' });
  await present('dark', 'en');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await shot('node-missing-dark-en');
  assert.equal(await page.locator('[data-agent-row="codex"][data-agent-state="node-missing"]').count(), 1, 'the row survives the locale and theme change');

  assert.deepEqual(report.errors, [], 'renderer errors');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await app?.close().catch(() => {});
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, error: report.error, errors: report.errors }, null, 2));
}
