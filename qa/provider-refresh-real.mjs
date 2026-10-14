// Desktop-1 real-app acceptance QA for the manual provider refresh (task 10-14 P1).
//
// It builds and starts the production app on an isolated profile/data/pipe with
// fake provider CLIs (one `.cmd` per builtin agent on a PATH that dropped every
// case variant of PATH). Each fake appends its provider, arguments and counts to
// a JSONL log, so the test can prove that after startup detection the app
// launches zero provider probes on its own and that one press of "Refresh
// provider status" launches exactly one fresh round. It never starts a real
// agent CLI, never opens a browser and never touches the user's profile.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const out = join(root, 'qa/results/provider-refresh');
const scratch = await mkdtemp(join(tmpdir(), 'tt-provider-refresh-'));
const appDir = join(scratch, 'app');
const bin = join(scratch, 'bin');
const events = join(scratch, 'provider-events.jsonl');
const report = { passed: false, checks: [], screenshots: [], invocations: {}, errors: [] };
let app; let page;

const delay = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 60_000) { const end = Date.now() + timeout; let error; for (;;) { try { const value = await probe(); if (value) return value; } catch (caught) { error = caught; } if (Date.now() > end) throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`); await delay(100); } }

async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'provider-refresh-qa', version: '0.1.0', main: 'main.cjs' }));
}

// One fake provider per builtin agent. It answers the probes the adapters make
// (`--version`, Codex `login status`, Claude `auth status --json`, OpenCode
// `auth list`) and speaks just enough ACP for the Kimi/Grok initialize probes.
const fakeProvider = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [provider, ...args] = process.argv.slice(2);
appendFileSync(process.env.TT_QA_EVENTS, JSON.stringify({ provider, args, at: Date.now() }) + '\\n');
const pause = async () => { const ms = Number(process.env.TT_QA_PROVIDER_DELAY_MS ?? 0); if (ms > 0) await new Promise(done => setTimeout(done, ms)); };
const once = { '--version': provider + ' 0.0.0-qa', 'login status': 'Logged in', 'auth status --json': '{"loggedIn":true}', 'auth list': '1 credentials' };
const key = args.includes('--version') ? '--version' : args.join(' ');
if (key in once) { await pause(); console.log(once[key]); process.exit(0); }
await pause();
// ACP worker (kimi/grok): answer initialize and any other request minimally.
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, load: {} } } } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`;
const fakeHost = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
appendFileSync(process.env.TT_QA_EVENTS, JSON.stringify({ provider: 'claude-sdk-host', args: [], at: Date.now() }) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: request.id, ok: { pid: process.pid, sdk: true } }) + '\\n');
});
`;

function readEvents() {
  if (!existsSync(events)) return [];
  return readFile(events, 'utf8').then(raw => raw.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)));
}
const invocationKey = record => `${record.provider} ${record.args.join(' ')}`.trim();
function multiset(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(invocationKey(row), (counts.get(invocationKey(row)) ?? 0) + 1);
  return counts;
}

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await Promise.all([bin, join(scratch, 'workspace'), join(scratch, 'home'), join(scratch, 'appdata')].map(path => mkdir(path, { recursive: true })));
  await writeFile(events, '');
  await writeFile(join(scratch, 'fake-provider.mjs'), fakeProvider);
  await writeFile(join(scratch, 'fake-claude-host.mjs'), fakeHost);
  await buildApp();

  const providers = ['codex', 'claude', 'kimi', 'opencode', 'grok', 'pi'];
  for (const name of providers) {
    await writeFile(join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${join(scratch, 'fake-provider.mjs')}" ${name} %*\r\n`);
  }
  const gitExe = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(value => /\\cmd\\git\.exe$/i.test(value)) || spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(Boolean);
  assert.ok(gitExe, 'git was not found');
  const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const dropped = /^(path|home|userprofile|appdata|localappdata|claudecode|claude_code_.*|claude_pid|claude_effort|threadterm_v3_.*|threadterm_claude_.*|tt_qa_.*|term_program.*|xterm.*)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !dropped.test(key)));
  Object.assign(env, {
    Path: [bin, dirname(process.execPath), dirname(gitExe), system32].join(';'),
    HOME: join(scratch, 'home'),
    USERPROFILE: join(scratch, 'home'),
    APPDATA: join(scratch, 'appdata'),
    LOCALAPPDATA: join(scratch, 'appdata'),
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-provider-refresh-${randomUUID()}`,
    THREADTERM_CLAUDE_NODE: process.execPath,
    THREADTERM_CLAUDE_SDK_HOST: join(scratch, 'fake-claude-host.mjs'),
    THREADTERM_CLAUDE_PATH: join(bin, 'claude.cmd'),
    TT_QA_EVENTS: events,
    TT_QA_PROVIDER_DELAY_MS: '1200',
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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 900));
  const present = async (language, theme) => {
    const snapshot = await request('runtime.snapshot');
    await request('settings.update', { patch: { language, theme, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  };

  // 1. Wait for the startup detection round to finish.
  await until(async () => ((await request('runtime.snapshot')).providers ?? []).length >= providers.length, 'startup provider round');
  await delay(500);
  const startup = await readEvents();
  assert.ok(startup.length > 0, 'startup detection launched no provider CLI');
  for (const name of providers) assert.ok(startup.some(row => row.provider === name), `startup did not probe ${name}`);
  report.invocations.startup = startup;

  // 2. Sixty seconds of snapshot polls and settings updates must not probe.
  const beforeIdle = (await readEvents()).length;
  for (let second = 0; second < 60; second++) {
    await request('runtime.snapshot');
    if (second % 12 === 0) {
      const snapshot = await request('runtime.snapshot');
      await request('settings.update', { patch: { notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
    }
    await delay(1000);
  }
  const afterIdle = await readEvents();
  assert.equal(afterIdle.length, beforeIdle, `idle snapshots and settings updates launched ${afterIdle.length - beforeIdle} provider CLIs`);
  check('60 s of runtime.snapshot polls plus 5 settings.update calls launched zero provider processes');

  // 3. Open Settings → Tools → Provider accounts at a wide, light, en surface.
  await present('en', 'light');
  await page.locator('.side-foot .user-row').click();
  await page.locator('.shell-menu-foot').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: /Tools/i }).click();
  await page.locator('details.settings-tool-accounts > summary').click();
  const panel = page.locator('.provider-settings');
  await panel.waitFor({ state: 'visible' });
  await until(async () => (await panel.locator('.settings-table article').count()) >= providers.length, 'provider rows');

  // 4. Refresh must show the checking state and probe each CLI once more.
  const beforeRefresh = (await readEvents()).length;
  const refreshButton = panel.getByRole('button', { name: 'Refresh provider status', exact: true });
  await refreshButton.click();
  await until(() => panel.getByRole('button', { name: 'Checking providers…', exact: true }).getAttribute('aria-busy').then(value => value === 'true'), 'checking state');
  assert.equal(await panel.locator('.settings-table article').count() >= providers.length, true, 'the provider list stays visible while checking');
  await until(() => panel.getByText('Provider status updated.', { exact: true }).count(), 'updated status', 30_000);
  const refreshRound = (await readEvents()).slice(beforeRefresh);
  assert.ok(refreshRound.length > 0, 'Refresh launched no provider CLI');

  // Every CLI the startup round ran is probed again; the only documented
  // exception is Claude's Chat-CLI `--version`, cached per file state by
  // `claude_cli_version` (runtime/src/providers/claude.rs:1008), so the second
  // round skips the duplicate instead of re-running it.
  const startCounts = multiset(startup);
  const refreshCounts = multiset(refreshRound);
  const unexpected = [...refreshCounts.keys()].filter(key => !startCounts.has(key));
  const missing = [...startCounts.keys()].filter(key => !refreshCounts.has(key));
  const countDiffs = [...startCounts.keys()].filter(key => refreshCounts.has(key)).map(key => [key, refreshCounts.get(key) - startCounts.get(key)]).filter(([, diff]) => diff !== 0);
  report.invocations.refresh = refreshRound;
  report.invocations.unexpected = unexpected;
  report.invocations.missing = missing;
  report.invocations.countDiffs = countDiffs;
  assert.deepEqual(unexpected, [], `refresh ran a check the startup round did not: ${unexpected.join(', ')}`);
  assert.deepEqual(missing, [], `refresh skipped a startup check: ${missing.join(', ')}`);
  const allowedCountDiffs = countDiffs.filter(([key, diff]) => !(key === 'claude --version' && diff === -1));
  assert.deepEqual(allowedCountDiffs, [], `unexpected refresh count change: ${JSON.stringify(allowedCountDiffs)}`);
  check('one Refresh launched exactly the startup checks again (Claude --version cached once per file state)');

  // 5. Thirty more idle seconds launch nothing.
  const beforeSecondIdle = (await readEvents()).length;
  for (let second = 0; second < 30; second++) { await request('runtime.snapshot'); await delay(1000); }
  assert.equal((await readEvents()).length, beforeSecondIdle, 'post-refresh idle snapshots launched provider CLIs');
  check('30 s after the refresh launched zero further provider processes');

  // 6. Screenshot and VC matrix: idle, checking and updated at 420/1100 px,
  // light/dark, en/zh-CN. Each cell clicks Refresh so the checking state is
  // really the live state, then waits for the updated status.
  for (const [language, theme, width] of [['en', 'light', 1100], ['en', 'dark', 1100], ['en', 'light', 420], ['en', 'dark', 420], ['zh-CN', 'light', 1100], ['zh-CN', 'dark', 1100], ['zh-CN', 'light', 420], ['zh-CN', 'dark', 420]]) {
    await present(language, theme);
    await app.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0].setContentSize(nextWidth, 900), width);
    await until(async () => (await page.evaluate(() => document.documentElement.lang)) === language && (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, `${language}/${theme} presentation`);
    const name = label => `provider-refresh-${label}-${language}-${theme}-${width}.png`;
    await panel.scrollIntoViewIfNeeded();
    await panel.getByText(language === 'zh-CN' ? '提供商状态已更新。' : 'Provider status updated.', { exact: true }).waitFor({ state: 'detached', timeout: 15_000 });
    await page.screenshot({ path: join(out, name('idle')), animations: 'disabled' }); report.screenshots.push(name('idle'));
    const button = panel.getByRole('button', { name: language === 'zh-CN' ? '刷新提供商状态' : 'Refresh provider status', exact: true });
    await button.click();
    await until(() => panel.locator('button[aria-busy="true"]').count(), `checking ${language}/${theme}/${width}`);
    await page.screenshot({ path: join(out, name('checking')), animations: 'disabled' }); report.screenshots.push(name('checking'));
    await until(() => panel.getByText(language === 'zh-CN' ? '提供商状态已更新。' : 'Provider status updated.', { exact: true }).count(), `updated ${language}/${theme}/${width}`, 30_000);
    await page.screenshot({ path: join(out, name('updated')), animations: 'disabled' }); report.screenshots.push(name('updated'));
    for (const label of ['idle', 'checking', 'updated']) {
      const consistency = await checkControlConsistency(page, '.provider-settings');
      assertNoControlViolations(consistency, `${name(label)} provider-settings`);
    }
  }
  check('the idle/checking/updated surfaces pass the VC control check at 420/1100 px, light/dark, en/zh-CN');

  assert.deepEqual(report.errors, [], report.errors.join('\n'));
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack || error.message : String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) {
    await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  }
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  try { report.events = await readEvents(); } catch { /* best effort */ }
  await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (existsSync(join(scratch, 'data/runtime.log'))) await writeFile(join(out, 'runtime.log'), await readFile(join(scratch, 'data/runtime.log'))).catch(() => {});
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
  console.log(report.passed ? 'PROVIDER REFRESH REAL-APP QA PASSED' : `PROVIDER REFRESH REAL-APP QA FAILED\n${report.errors.join('\n')}`);
}
assert.equal(report.passed, true, report.errors.join('\n'));
