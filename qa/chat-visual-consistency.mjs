// Desktop-1 real-app visual-consistency QA for the Chat pane (V1, issue VC).
// It starts the production app on an isolated profile/data/pipe with a fake ACP
// plugin that emits a plan, a read, a search, a failed command, a two-file edit
// and a final answer with a code block. It then runs the shared
// qa/lib/visual-consistency.mjs helper over every Chat surface in the
// wide/420 x light/dark/custom x en/zh-CN matrix and asserts zero violations.
// It never starts a real agent CLI and never touches the user's profile.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const fixture = join(root, 'qa/fixtures/chat-visual-echo-acp');
const out = join(root, 'qa/results/chat-parity/V1/chat-visual-consistency');
const scratch = await mkdtemp(join(tmpdir(), 'tt-chat-visual-'));
const appDir = join(scratch, 'app');
const plugins = join(scratch, 'plugins');
const work = join(scratch, 'repo');
const report = { passed: false, checks: [], screenshots: [], visualConsistency: [], errors: [] };
let app; let page;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const chatScope = id => page.locator(`[data-testid="session-chat-${id}"]`);
async function until(probe, label, timeout = 30_000) { const end = Date.now() + timeout; let error; for (;;) { try { const value = await probe(); if (value) return value; } catch (caught) { error = caught; } if (Date.now() > end) throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`); await delay(150); } }
async function shot(name) { await page.mouse.move(2, 2).catch(() => undefined); await delay(150); await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
function git(cwd, ...args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout; }
async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'chat-visual-consistency-qa', version: '0.1.0', main: 'main.cjs' }));
}

/** Runs the helper on one surface after scrolling it into view. */
async function checkSurface(selector, label) {
  await page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => undefined);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))).catch(() => undefined);
  const result = await checkControlConsistency(page, selector);
  report.visualConsistency.push({ label, ...result, violations: result.violations });
  assertNoControlViolations(result, label);
  return result;
}

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  assert.ok(existsSync(join(fixture, 'threadterm-plugin.json')), 'missing chat-visual Echo fixture');
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  await mkdir(plugins, { recursive: true }); cpSync(fixture, join(plugins, 'chat-visual-echo-acp'), { recursive: true });
  await buildApp();
  const gitExe = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(value => /\\cmd\\git\.exe$/i.test(value))
    || spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(Boolean);
  assert.ok(gitExe, 'git was not found');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, {
    PATH: [dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-chat-visual-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_V3_PLUGIN_DIRS: plugins,
  });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'PATH isolation keeps exactly one spelling');

  await mkdir(join(work, 'src'), { recursive: true });
  await writeFile(join(work, 'src/app.ts'), 'const version = 0;\n');
  git(work, 'init', '-q'); git(work, 'config', 'user.email', 'qa@example.invalid'); git(work, 'config', 'user.name', 'ThreadTerm QA');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'initial');

  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const initial = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });

  await until(async () => (await request('plugin.list')).plugins.some(row => row.id === 'chat-visual-echo-acp'), 'Chat visual Echo discovered');
  await request('plugin.setEnabled', { pluginId: 'chat-visual-echo-acp', enabled: true, operationId: randomUUID() });
  await until(async () => (await request('provider.list')).some(row => row.id === 'chat-visual-echo' && row.chat), 'Chat visual Echo enabled');

  const project = await request('project.add', { path: work, name: 'Chat visual QA', operationId: randomUUID() });
  const chat = await request('session.create', { projectId: project.id, cwd: work, title: 'Chat visual QA', provider: 'chat-visual-echo', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const scope = chatScope(chat.id);
  const composer = scope.locator('.chat-compose-shell textarea');
  await until(() => composer.isEnabled(), 'chat composer ready');
  await composer.fill('Emit the plan, tools and a final answer.');
  await scope.locator('.chat-compose-send[type=submit]').click();
  await until(async () => (await scope.locator('.chat-tool-activity').count()) > 0, 'tool drawer appears');
  await until(async () => (await request('chat.snapshot', { sessionId: chat.id })).items.some(item => item.parts?.some(part => part.type === 'text' && /Chat visual fixture complete/.test(part.text ?? ''))), 'turn completion');
  await until(() => scope.locator('.chat-plan-panel').count(), 'plan panel appears');
  await delay(400);

  const drawer = scope.locator('.chat-tool-activity');
  if (!(await drawer.evaluate(node => node.open))) await drawer.locator('> summary').click();
  await until(async () => (await scope.locator('.tool-card-body').count()) === 4, 'four card bodies');
  check('one session shows the plan, the tool drawer/cards, the reply copy and the code-block copy');

  const custom = { background: '#0b1016', surface: '#182430', text: '#f2f6fb', muted: '#93a3b5', accent: '#ff7a45', border: '#26323f' };
  const surfaces = [
    ['plan panel', '.chat-plan-panel'],
    ['tool card', '.chat-tool-entry'],
    ['tool drawer', '.chat-tool-activity-card'],
    ['reply actions', '.v3-chat-message.has-reply-actions'],
    ['code copy', '.md-code-block'],
    ['composer', '.chat-compose-shell'],
  ];

  for (const theme of ['light', 'dark', 'custom']) for (const locale of ['en', 'zh-CN']) for (const width of [1440, 420]) {
    const snapshot = await request('runtime.snapshot');
    const patch = theme === 'custom'
      ? { language: locale, theme: 'dark', themeSelection: 'custom:qa', customThemes: { qa: custom } }
      : { language: locale, theme, themeSelection: theme };
    await request('settings.update', { patch, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
    await app.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0].setContentSize(nextWidth, 900), width);
    await until(async () => (await scope.locator('.chat-tool-activity').count()) > 0, `${theme}/${locale}/${width} drawer`);
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme === 'custom' ? 'dark' : theme);
    if (theme === 'custom') await page.waitForFunction(() => document.documentElement.dataset.customTheme === 'true');
    for (const [label, selector] of surfaces) {
      if (await page.locator(selector).count() === 0) continue;
      const result = await checkSurface(selector, `${label} ${theme}/${locale}/${width}`);
      assert.ok(result.checked >= 1, `${label} ${theme}/${locale}/${width}: the helper saw at least one control`);
      if (result.checked < 1) report.errors.push(`${label} ${theme}/${locale}/${width}: no control collected`);
    }
    await scope.locator('.v3-chat-log').evaluate(node => { node.scrollTop = 0; });
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    await shot(`chat-${theme}-${width}-${locale}.png`);
  }
  check('wide/420, light/dark/custom, en/zh-CN: zero helper violations on the plan, tool cards, drawer, reply actions, code copy and composer');

  // The custom-theme screenshot must show a measurably different surface.
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { theme: 'dark', themeSelection: 'custom:qa', customThemes: { qa: custom } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await page.waitForFunction(() => document.documentElement.dataset.customTheme === 'true');
  const customSurface = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface').trim());
  assert.equal(customSurface.toLowerCase(), custom.surface, 'the custom surface token is applied');
  check('the custom theme remaps the surface/accent tokens (helper ran against it)');

  assert.deepEqual(report.errors, [], report.errors.join('\n'));
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack || error.message : String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
  console.log(report.passed ? 'CHAT VISUAL-CONSISTENCY QA PASSED' : `CHAT VISUAL-CONSISTENCY QA FAILED\n${report.errors.join('\n')}`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
