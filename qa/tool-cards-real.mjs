// Desktop-1 real-app acceptance QA for the B2/B3 typed tool cards. It builds and
// starts the production app on an isolated profile/data/pipe with a fake ACP
// plugin that emits one read, one search, one failed command (output + exit
// code) and a two-file edit in a single turn. It never starts a real agent CLI
// and never touches the user's profile or clipboard.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixture = join(root, 'qa/fixtures/tool-cards-echo-acp');
const out = join(root, 'qa/results/chat-parity/B2B3/tool-cards-real');
const scratch = await mkdtemp(join(tmpdir(), 'tt-tool-cards-'));
const appDir = join(scratch, 'app');
const plugins = join(scratch, 'plugins');
const work = join(scratch, 'repo');
const report = { passed: false, checks: [], screenshots: [], errors: [] };
let app; let page;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const chatScope = id => page.locator(`[data-testid="session-chat-${id}"]`);
async function until(probe, label, timeout = 30_000) { const end = Date.now() + timeout; let error; for (;;) { try { const value = await probe(); if (value) return value; } catch (caught) { error = caught; } if (Date.now() > end) throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`); await delay(150); } }
async function shot(name) { await delay(200); await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
function git(cwd, ...args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout; }
async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'tool-cards-real-qa', version: '0.1.0', main: 'main.cjs' }));
}

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  assert.ok(existsSync(join(fixture, 'threadterm-plugin.json')), 'missing tool-cards Echo fixture');
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  await mkdir(plugins, { recursive: true }); cpSync(fixture, join(plugins, 'tool-cards-echo-acp'), { recursive: true });
  await buildApp();
  const gitExe = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(value => /\\cmd\\git\.exe$/i.test(value))
    || spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(Boolean);
  assert.ok(gitExe, 'git was not found');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, {
    PATH: [dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-tool-cards-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_V3_PLUGIN_DIRS: plugins,
  });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'PATH isolation keeps exactly one spelling');

  await mkdir(join(work, 'src'), { recursive: true });
  await writeFile(join(work, 'src/app.ts'), 'const version = 0;\n');
  git(work, 'init', '-q'); git(work, 'config', 'user.email', 'qa@example.invalid'); git(work, 'config', 'user.name', 'ThreadTerm QA');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'initial');
  await writeFile(join(work, 'src/app.ts'), 'const version = 1;\n');
  await writeFile(join(work, 'src/new.ts'), 'export const added = true;\n');

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

  await until(async () => (await request('plugin.list')).plugins.some(row => row.id === 'tool-cards-echo-acp'), 'Tool cards Echo discovered');
  await request('plugin.setEnabled', { pluginId: 'tool-cards-echo-acp', enabled: true, operationId: randomUUID() });
  await until(async () => (await request('provider.list')).some(row => row.id === 'tool-cards-echo' && row.chat), 'Tool cards Echo enabled');

  const project = await request('project.add', { path: work, name: 'Tool cards QA', operationId: randomUUID() });
  const chat = await request('session.create', { projectId: project.id, cwd: work, title: 'Tool cards QA', provider: 'tool-cards-echo', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const scope = chatScope(chat.id);
  const composer = scope.locator('.chat-compose-shell textarea');
  await until(() => composer.isEnabled(), 'chat composer ready');
  await composer.fill('Emit one read, one search, one command and a two-file edit.');
  await scope.locator('.chat-compose-send[type=submit]').click();
  await until(async () => (await scope.locator('.chat-tool-activity').count()) > 0, 'tool drawer appears');
  await until(async () => (await request('chat.snapshot', { sessionId: chat.id })).items.some(item => item.parts?.some(part => part.type === 'text' && part.text === 'Tool-card fixture complete.')), 'turn completion');
  await delay(500);

  // Collapsed drawer: the shell of every entry exists, but no card body is built.
  const drawer = scope.locator('.chat-tool-activity');
  assert.equal(await drawer.evaluate(node => node.open), false, 'the drawer starts collapsed');
  assert.equal(await scope.locator('.chat-tool-entry').count(), 4, 'four tool entries');
  assert.equal(await scope.locator('.tool-card-body').count(), 0, 'a collapsed drawer builds no card bodies');
  const kinds = await scope.locator('.chat-tool-entry').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-tool-kind')));
  assert.deepEqual(kinds, ['read', 'search', 'command', 'edit'], `entry kinds: ${kinds.join(',')}`);
  check('collapsed drawer keeps every entry shell and builds no card bodies');

  // The B3 turn summary line.
  const summary = (await scope.locator('.chat-tool-count').innerText()).trim();
  assert.equal(summary, 'Explored 1 file · Searched 1 · Ran 1 command · Edited 2 files · 1 failed', `summary line: ${summary}`);
  assert.equal(await scope.locator('.chat-tool-failed-count').innerText(), '1 failed / interrupted');
  check('the collapsed summary counts explored, searched, ran, edited files and failures');

  // Expanded typed bodies.
  await drawer.locator('> summary').click();
  await until(async () => (await scope.locator('.tool-card-body').count()) === 4, 'four card bodies');
  const readBody = scope.locator('.chat-tool-entry[data-tool-kind=read]');
  assert.match(await readBody.locator('.tool-path').innerText(), /src\/app\.ts/);
  assert.equal(await readBody.locator('.tool-chip').first().innerText(), 'offset 1');
  assert.equal(await readBody.locator('.tool-chip').nth(1).innerText(), 'limit 40');
  const searchBody = scope.locator('.chat-tool-entry[data-tool-kind=search]');
  assert.equal((await searchBody.locator('.tool-search code').innerText()).trim(), 'describeTool');
  assert.match(await searchBody.locator('.tool-chip-row').innerText(), /3 matches in 2 files/);
  const commandBody = scope.locator('.chat-tool-entry[data-tool-kind=command]');
  assert.equal((await commandBody.locator('.tool-command code').innerText()).trim(), 'npm run typecheck');
  assert.equal((await commandBody.locator('.tool-chip.is-danger').innerText()).trim(), 'exit 1');
  assert.match(await commandBody.locator('.tool-output').innerText(), /Type string is not assignable to type number/);
  const editBody = scope.locator('.chat-tool-entry[data-tool-kind=edit]');
  assert.equal(await editBody.locator('.tool-edit-file').count(), 2, 'the edit card lists both files');
  const counts = await editBody.locator('.tool-edit-counts').allInnerTexts();
  assert.equal(counts[0].replace(/\s+/g, ' ').trim(), '+1 −1', `src/app.ts counts: ${counts[0]}`);
  assert.equal(counts[1].replace(/\s+/g, ' ').trim(), '+1 −0', `src/new.ts counts: ${counts[1]}`);
  check('expanded typed cards show read/search/command bodies and per-file +a/-d counts');
  await editBody.scrollIntoViewIfNeeded();
  await shot('tool-cards-light-1440-en-edit-card.png');

  // Screenshot matrix: wide/420, light/dark, en/zh-CN, collapsed and expanded.
  for (const theme of ['light', 'dark']) for (const width of [1440, 420]) for (const locale of ['en', 'zh-CN']) {
    const snapshot = await request('runtime.snapshot');
    await request('settings.update', { patch: { language: locale, theme }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
    await app.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0].setContentSize(nextWidth, 900), width);
    await until(async () => (await scope.locator('.chat-tool-activity').count()) > 0, `${locale}/${theme}/${width} drawer`);
    if (await drawer.evaluate(node => node.open)) await drawer.locator('> summary').click();
    await shot(`tool-cards-${theme}-${width}-${locale}-collapsed.png`);
    const label = (await scope.locator('.chat-tool-count').innerText()).trim();
    assert.match(label, locale === 'zh-CN' ? /查看 1 个文件/ : /Explored 1 file/, `${locale} summary label`);
    await drawer.locator('> summary').click();
    await until(async () => (await scope.locator('.tool-card-body').count()) === 4, `${locale}/${theme}/${width} expanded`);
    await shot(`tool-cards-${theme}-${width}-${locale}-expanded.png`);
    const pane = scope.locator('.chat-log-shell');
    const overflow = await pane.evaluate(element => element.scrollWidth - element.clientWidth);
    assert.ok(overflow <= 1, `${locale}/${theme}/${width} has no horizontal overflow (${overflow})`);
  }
  check('light/dark, en/zh-CN, wide and 420 px matrix shows the collapsed and expanded cards without overflow');

  // Open diff opens the working-tree diff view. Reset to English first because
  // the screenshot matrix leaves the last iteration in zh-CN.
  const reset = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en', theme: 'light' }, expectedRevision: reset.settings.revision, operationId: randomUUID() });
  await until(async () => (await drawer.evaluate(node => node.open)) === true, 'drawer expanded for Open diff');
  const modifiedRow = scope.locator('.tool-edit-file', { hasText: 'src/app.ts' });
  await modifiedRow.locator('.tool-card-action', { hasText: /Open diff|查看差异/ }).click();
  await page.locator('[data-testid="file-diff-surface"]').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="file-diff-surface"]');
    return node && !/Loading diff/.test(node.textContent || '');
  }, undefined, { timeout: 20_000 });
  const diffText = await page.locator('[data-testid="file-diff-surface"]').innerText();
  assert.match(diffText, /app\.ts/, 'the diff surface names the edited file');
  assert.match(diffText, /version = 2|const version/, 'the diff surface renders the changed line');
  await shot('tool-cards-diff-surface.png');
  check('Open diff opens the working-tree diff view for the edited file');

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
  console.log(report.passed ? 'TOOL CARDS REAL-APP QA PASSED' : `TOOL CARDS REAL-APP QA FAILED\n${report.errors.join('\n')}`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
