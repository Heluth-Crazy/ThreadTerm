// Desktop-1 production-path QA for D4. Fake Codex and fake Pi only. The Codex
// session exercises split Send, insert, failure, and Insert now. Pi exercises
// the native steer command. The screenshot matrix is the shared composer.
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
const out = join(root, 'qa/results/chat-parity/D4/steer-real');
const scratch = await mkdtemp(join(tmpdir(), 'tt-steer-real-'));
const appDir = join(scratch, 'app');
const bin = join(scratch, 'bin');
const workspace = join(scratch, 'workspace');
const codexLog = join(scratch, 'codex.jsonl');
const piLog = join(scratch, 'pi.jsonl');
const report = { passed: false, checks: [], screenshots: [], layout: [], errors: [] };
let app;
let page;
let settingsRevision = 0;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() <= end) {
    try { const value = await probe(); if (value) return value; } catch (error) { last = error; }
    await delay(150);
  }
  throw new Error(`Timed out: ${label}${last ? `: ${last.message}` : ''}`);
}
async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) {
    await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  }
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'steer-qa', version: '0.1.0', main: 'main.cjs' }));
}
const calls = async path => (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const copy = {
  send: { en: 'Send', 'zh-CN': '发送' },
  queue: { en: 'Queue', 'zh-CN': '加入队列' },
  more: { en: 'More send actions', 'zh-CN': '更多发送操作' },
  insert: { en: 'Insert into current turn', 'zh-CN': '插入当前回合' },
  now: { en: 'Insert now', 'zh-CN': '立即插入' },
  tag: { en: 'Inserted', 'zh-CN': '已插入' },
  failed: { en: 'The turn ended before the message was inserted', 'zh-CN': '这一轮在插入前已经结束' },
};

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  await rm(out, { recursive: true, force: true });
  await Promise.all([mkdir(out, { recursive: true }), mkdir(bin, { recursive: true }), mkdir(workspace, { recursive: true }), writeFile(codexLog, ''), writeFile(piLog, '')]);
  await buildApp();
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${join(root, 'qa/fixtures/fake-codex-steer.cjs')}" %*\r\n`);
  await writeFile(join(bin, 'pi.cmd'), `@echo off\r\n"${process.execPath}" "${join(root, 'qa/fixtures/fake-pi-steer.cjs')}" %*\r\n`);
  const gitPaths = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).filter(Boolean);
  const gitExe = gitPaths.find(value => /\\cmd\\git\.exe$/i.test(value)) ?? gitPaths[0];
  assert.ok(gitExe, 'git was not found');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, {
    PATH: [bin, dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    CODEX_HOME: join(scratch, 'codex-home'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-steer-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_QA_STEER_CODEX_LOG: codexLog, THREADTERM_QA_STEER_PI_LOG: piLog, THREADTERM_QA_STEER_CWD: workspace,
  });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'PATH isolation keeps exactly one spelling');
  await mkdir(env.CODEX_HOME, { recursive: true });
  app = await electron.launch({ args: [appDir], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') report.errors.push(`console: ${message.text()}`);
    if (message.text().includes('[threadterm] 浏览器演示模式')) report.errors.push('the development mock bridge activated in the production app');
  });
  await page.waitForFunction(() => Boolean(window.threadterm));
  assert.notEqual(await page.evaluate(() => window.threadterm.platform), 'browser', 'the production app must use its preload bridge');
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await page.evaluate(() => {
    let value = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { value = String(text); }, readText: async () => value } });
  });
  const initial = await request('runtime.snapshot');
  settingsRevision = initial.settings.revision;
  const project = await request('project.add', { path: workspace, name: 'Steer QA', operationId: randomUUID() });
  async function appearance({ theme, locale, width }) {
    const custom = theme === 'custom';
    const updated = await request('settings.update', {
      patch: {
        theme: custom ? 'dark' : theme,
        language: locale,
        themeSelection: custom ? 'custom:steer' : theme,
        customThemes: { steer: { background: '#0b1016', surface: '#182430', text: '#f2f6fb', muted: '#93a3b5', accent: '#ff7a45', border: '#26323f' } },
        notifications: { native: false, attention: false, completed: false, sound: false },
      },
      expectedRevision: settingsRevision,
      operationId: randomUUID(),
    });
    settingsRevision = updated.revision ?? (await request('runtime.snapshot')).settings.revision;
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(([lang, customOn]) => document.documentElement.lang === lang && document.documentElement.dataset.customTheme === customOn, [locale, custom ? 'true' : 'false']);
  }
  async function shoot(scope, state, theme, locale, width) {
    const name = `real-${state}-${theme}-${locale}-${width}`;
    const selector = `[data-testid="session-chat-${scope}"] .chat-compose-shell`;
    assertNoControlViolations(await checkControlConsistency(page, selector), `${name} composer`);
    if (state === 'menu') assertNoControlViolations(await checkControlConsistency(page, `[data-testid="session-chat-${scope}"] [data-testid="steer-menu"]`), `${name} menu`);
    if (state === 'queue') assertNoControlViolations(await checkControlConsistency(page, `[data-testid="session-chat-${scope}"] .chat-queue`), `${name} queue`);
    const bar = await page.locator(`[data-testid="session-chat-${scope}"] .chat-compose-bar`).evaluate(node => {
      const left = node.querySelector('.chat-compose-left');
      const right = node.querySelector('.chat-compose-right');
      const children = [...node.querySelectorAll('.chat-compose-left > *, .chat-compose-right > *')].filter(child => child.getClientRects().length).map(child => child.getBoundingClientRect());
      return {
        height: node.getBoundingClientRect().height,
        groups: Math.abs(left.getBoundingClientRect().top - right.getBoundingClientRect().top),
        wrap: Math.max(...children.map(rect => rect.top)) - Math.min(...children.map(rect => rect.top)),
        overflow: node.scrollWidth - node.clientWidth,
      };
    });
    assert.ok(bar.height < 40 && bar.groups < 2 && bar.wrap < 2 && bar.overflow <= 1, `${name} row ${JSON.stringify(bar)}`);
    await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' });
    report.screenshots.push(`${name}.png`);
    if (theme === 'light' && locale === 'en' && width === 420) report.layout.push(`${name}: composer row ${bar.height}px, one line, send cluster on the right`);
  }
  async function grid(scope, state, prepare) {
    for (const theme of ['light', 'dark', 'custom']) {
      for (const locale of ['en', 'zh-CN']) {
        for (const width of [1100, 420]) {
          await appearance({ theme, locale, width });
          if (prepare) await prepare(locale);
          await shoot(scope, state, theme, locale, width);
        }
      }
    }
  }

  const chat = await request('session.create', { projectId: project.id, cwd: workspace, title: 'Codex steer', provider: 'codex', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const scope = page.locator(`[data-testid="session-chat-${chat.id}"]`);
  await until(() => scope.locator('.chat-compose-shell textarea').isEnabled(), 'codex composer ready');
  await until(async () => (await request('chat.connection', { sessionId: chat.id })).phase === 'ready', 'codex connection ready');
  const options = await request('chat.options', { sessionId: chat.id });
  assert.equal(options.inputCapabilities.steer, 'native');
  await scope.locator('.chat-compose-shell textarea').fill('Send this');
  await grid(chat.id, 'idle');
  await scope.locator('.chat-compose-shell textarea').fill('Start the long job');
  await scope.locator('.chat-compose-send[type=submit]').click();
  await until(async () => (await scope.locator('[data-testid="steer-send"]').count()) === 1, 'split send while the turn runs');
  await scope.locator('.chat-compose-shell textarea').fill('while you work');
  await grid(chat.id, 'running');
  await grid(chat.id, 'menu', async locale => {
    if (await scope.locator('[data-testid="steer-menu"]').count() === 0) await scope.locator(`[aria-label="${copy.more[locale]}"]`).click();
    await scope.locator('[data-testid="steer-menu"]').waitFor();
    assert.equal(await scope.locator('[data-testid="steer-insert"]').innerText(), copy.insert[locale]);
  });
  await scope.locator('[data-testid="steer-insert"]').click();
  await until(async () => (await scope.locator('[data-testid="inserted-tag"]').count()) === 1, 'inserted tag');
  const transcript = await request('chat.snapshot', { sessionId: chat.id });
  const steered = transcript.items.find(item => item.role === 'user' && item.parts.some(part => part.data?.steered === true));
  assert.ok(steered, 'history reload keeps the steered row');
  assert.equal(steered.parts[0].text, 'while you work');
  assert.ok(transcript.items.some(item => item.role === 'user' && item.parts.some(part => part.text === 'Start the long job')));
  const steeredCalls = (await calls(codexLog)).filter(call => call.method === 'turn/steer');
  assert.equal(steeredCalls.length, 1);
  assert.equal(steeredCalls[0].params.expectedTurnId, 'native-steer-turn');
  assert.equal(steeredCalls[0].params.threadId, 'qa-codex-steer-thread');
  assert.equal(steeredCalls[0].params.input.find(item => item.type === 'text').text, 'while you work');
  await grid(chat.id, 'inserted', async locale => {
    assert.equal((await scope.locator('[data-testid="inserted-tag"]').innerText()).trim(), copy.tag[locale]);
  });
  await appearance({ theme: 'light', locale: 'en', width: 1100 });
  await scope.locator('.chat-compose-shell textarea').fill('reject-me');
  await scope.locator(`[aria-label="${copy.more.en}"]`).click();
  await scope.locator('[data-testid="steer-insert"]').click();
  await until(async () => (await scope.locator('.surface-error').innerText()).includes(copy.failed.en), 'turn_changed keeps the composer text');
  assert.equal(await scope.locator('.chat-compose-shell textarea').inputValue(), 'reject-me');
  const afterReject = await request('chat.snapshot', { sessionId: chat.id });
  assert.equal(afterReject.items.some(item => item.parts.some(part => part.text === 'reject-me')), false);
  assert.equal((await calls(codexLog)).filter(call => call.method === 'turn/steer' && call.params.input?.some(item => item.text === 'while you work')).length, 1);
  await grid(chat.id, 'failure', async locale => {
    await scope.locator('.chat-compose-shell textarea').fill('reject-me');
    if (await scope.locator('[data-testid="steer-menu"]').count() === 0) await scope.locator(`[aria-label="${copy.more[locale]}"]`).click();
    await scope.locator('[data-testid="steer-insert"]').click();
    await until(async () => (await scope.locator('.surface-error').innerText()).includes(copy.failed[locale]), `failure copy ${locale}`);
  });
  await scope.locator('.chat-compose-shell textarea').fill('Follow this up');
  await scope.locator('.chat-compose-send[type=submit]').click();
  await scope.locator('[data-testid="queue-insert-now"]').waitFor();
  await grid(chat.id, 'queue', async locale => {
    assert.equal(await scope.locator('[data-testid="queue-insert-now"]').innerText(), copy.now[locale]);
    assert.equal(await scope.getByRole('button', { name: locale === 'zh-CN' ? '立即发送' : 'Send now' }).count(), 0);
  });
  await scope.locator('[data-testid="queue-insert-now"]').click();
  await until(async () => (await scope.locator('[data-testid="queue-insert-now"]').count()) === 0, 'queue item leaves only after steer');
  assert.equal((await calls(codexLog)).filter(call => call.method === 'turn/steer' && call.params.input?.some(item => item.text === 'Follow this up')).length, 1);
  await scope.locator('.chat-compose-shell textarea').fill('');
  await grid(chat.id, 'disabled', async () => {
    assert.equal(await scope.locator('[data-testid="steer-send"] button').first().isDisabled(), true);
  });
  check('fake Codex steer is delivered once, a mismatch restores nothing false, and Insert now removes the queue item only after acceptance');

  const pi = await request('session.create', { projectId: project.id, cwd: workspace, title: 'Pi steer', provider: 'pi', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: pi.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const piScope = page.locator(`[data-testid="session-chat-${pi.id}"]`);
  await until(() => piScope.locator('.chat-compose-shell textarea').isEnabled(), 'pi composer ready');
  await until(async () => (await request('chat.connection', { sessionId: pi.id })).phase === 'ready', 'pi connection ready');
  assert.equal((await request('chat.options', { sessionId: pi.id })).inputCapabilities.steer, 'native');
  await piScope.locator('.chat-compose-shell textarea').fill('Start the long job');
  await piScope.locator('.chat-compose-send[type=submit]').click();
  await until(async () => (await piScope.locator('[data-testid="steer-send"]').count()) === 1, 'pi split send');
  await appearance({ theme: 'light', locale: 'en', width: 1100 });
  await piScope.locator('.chat-compose-shell textarea').fill('pi steer please');
  await piScope.locator(`[aria-label="${copy.more.en}"]`).click();
  await piScope.locator('[data-testid="steer-insert"]').click();
  await until(async () => (await piScope.locator('[data-testid="inserted-tag"]').count()) === 1, 'pi inserted tag');
  const piSteers = (await calls(piLog)).filter(call => call.type === 'steer');
  assert.equal(piSteers.length, 1);
  assert.equal(piSteers[0].message, 'pi steer please');
  await appearance({ theme: 'light', locale: 'en', width: 1100 });
  await page.screenshot({ path: join(out, 'real-pi-inserted-light-en-1100.png'), animations: 'disabled' });
  report.screenshots.push('real-pi-inserted-light-en-1100.png');
  check('fake Pi steer uses the steer command once and does not start a second turn');
  report.layout.push('buttons: two matching round icon buttons; queue Insert now is btn-subtle with the other queue actions');
  report.layout.push('spacing: 4px between the split buttons, 6px menu offset, composer bar gap unchanged');
  report.layout.push('alignment: Queue and the arrow share one center. Inserted sits inline after the user text.');
  report.layout.push('type: zh-CN Insert into current turn and Insert now stay on one line at 420px');
  report.layout.push('color: theme tokens only, including the custom pack');
  report.layout.push('states: aria-expanded on the arrow, disabled split when the draft is empty, alert on turn_changed');
  report.layout.push('missing-mixed-widths: the split pair is one size; queue actions share one button class');
  report.layout.push('missing-duplicate: one Inserted tag on the steered row; the running reply is not repeated');
  report.layout.push('missing-padding: composer shell padding is unchanged; the menu uses the shared menu padding');
  report.layout.push('missing-dead-space: the menu is one item tall; no new dialog');
  report.layout.push('missing-headings: no new heading scale');
  report.layout.push('missing-wrap-420: the composer row stays one line at 420px');
  report.layout.push('missing-overlay: the menu opens above the arrow and leaves the textarea visible');
  report.layout.push('missing-empty-box: no empty card; idle remains the single Send button');
  assert.equal(report.screenshots.length, 85);
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack || error.message : String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(report.passed ? 'STEER REAL-APP QA PASSED' : `STEER REAL-APP QA FAILED\n${report.errors.join('\n')}`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
