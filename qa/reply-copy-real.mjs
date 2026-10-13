// Desktop-1 real-app acceptance QA for the A2 Chat reply-copy row and Markdown
// code-block copy. It builds and starts the production app on an isolated
// profile/data/pipe with a dedicated fake ACP provider, and installs an
// in-page fake clipboard (there is no usable Windows clipboard here, and QA
// must never touch the user's).
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixture = join(root, 'qa/fixtures/reply-copy-echo-acp');
const out = join(root, 'qa/results/chat-parity/A2/reply-copy-real');
const scratch = await mkdtemp(join(tmpdir(), 'tt-reply-copy-'));
const appDir = join(scratch, 'app');
const report = { passed: false, checks: [], screenshots: [], errors: [] };
const answer = '# Reply\n\nThe copy action writes the reply Markdown.\n\n```ts\nconst copied = true;\n```';
let app; let page;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const composer = id => page.locator(`[data-testid="session-chat-${id}"] .chat-compose-shell textarea`);
async function until(probe, label, timeout = 30_000) { const end = Date.now() + timeout; let error; for (;;) { try { const value = await probe(); if (value) return value; } catch (caught) { error = caught; } if (Date.now() > end) throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ''}`); await delay(150); } }
async function shot(name) { await delay(200); await page.screenshot({ path: join(out, name), animations: 'disabled' }); report.screenshots.push(name); }
async function buildApp() { await mkdir(appDir, { recursive: true }); for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' }); await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } }); await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'reply-copy-echo-qa', version: '0.1.0', main: 'main.cjs' })); }
async function enableFixture() { await until(async () => (await request('plugin.list')).plugins.some(row => row.id === 'reply-copy-echo-acp'), 'Reply copy Echo discovered'); await request('plugin.setEnabled', { pluginId: 'reply-copy-echo-acp', enabled: true, operationId: randomUUID() }); await until(async () => (await request('provider.list')).some(row => row.id === 'reply-copy-echo' && row.chat), 'Reply copy Echo chat provider enabled'); }
const clipboardText = () => page.evaluate(() => window.__qaClipboard.get());

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build runtime/target-qa before running this QA`);
  assert.ok(existsSync(join(fixture, 'threadterm-plugin.json')), 'missing reply-copy Echo fixture');
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true }); await buildApp();
  const plugins = join(scratch, 'plugins'); cpSync(fixture, join(plugins, 'reply-copy-echo-acp'), { recursive: true });
  const gitExe = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(value => /\\cmd\\git\.exe$/i.test(value)) || spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find(Boolean); assert.ok(gitExe, 'git was not found');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  Object.assign(env, { PATH: [dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-reply-copy-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PLUGIN_DIRS: plugins });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'PATH isolation keeps exactly one spelling');
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60_000 }); page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(20_000); page.on('pageerror', error => report.errors.push(`page: ${error.message}`)); page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.evaluate(() => { let store = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { store = String(text); }, readText: async () => store, write: async () => {}, read: async () => [] } }); window.__qaClipboard = { get: () => store, set: value => { store = String(value); } }; });
  await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor(); await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const initial = await request('runtime.snapshot'); await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });
  await enableFixture();
  const work = join(scratch, 'repo'); await mkdir(work, { recursive: true }); await writeFile(join(work, 'README.md'), '# Reply copy real-app QA\n');
  const project = await request('project.add', { path: work, name: 'Reply copy QA', operationId: randomUUID() });
  const chat = await request('session.create', { projectId: project.id, cwd: work, title: 'Reply copy Echo', provider: 'reply-copy-echo', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await until(() => composer(chat.id).isEnabled(), 'chat composer ready');
  await composer(chat.id).fill('Write the reply-copy fixture answer.');
  await page.locator(`[data-testid="session-chat-${chat.id}"] .chat-compose-send[type=submit]`).click();
  const scope = page.locator(`[data-testid="session-chat-${chat.id}"]`);
  await until(async () => (await scope.locator('.v3-chat-message.assistant').allInnerTexts()).some(text => text.includes('The copy action writes the reply Markdown.')), 'assistant reply rendered');

  const reply = scope.locator('article.has-reply-actions').first();
  await reply.waitFor();
  // E4 adds "Fork from here" to the same row, so target Copy by its accessible
  // name (localized, and it flips to Copied/已复制 after a copy).
  const copyAction = reply.getByRole('button', { name: /^(Copy|Copied|复制|已复制)$/ });
  assert.equal(await scope.locator('.chat-message-actions').count(), 1, 'exactly the completed assistant reply owns a copy row');
  assert.equal(await scope.locator('article.user .chat-message-actions').count(), 0, 'the user message has no copy row');
  check('real app shows the copy row only on the completed assistant reply');

  const rowOpacity = await reply.locator('.chat-message-actions').evaluate(row => getComputedStyle(row).opacity);
  assert.equal(rowOpacity, '0', 'the copy row is hidden until hover or focus');
  const heightBefore = await reply.evaluate(article => article.getBoundingClientRect().height);
  await reply.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('article.has-reply-actions .chat-message-actions')).opacity === '1');
  const heightAfter = await reply.evaluate(article => article.getBoundingClientRect().height);
  assert.equal(heightAfter, heightBefore, 'hovering does not change the message height');
  check('hover reveals the row without reflow in the real app');

  await copyAction.click();
  await until(async () => (await clipboardText()) === answer, 'reply copy wrote the Markdown source');
  assert.equal(await clipboardText(), answer, 'reply Copy writes the Markdown source exactly');
  assert.equal(await copyAction.textContent(), 'Copied', 'the label confirms the copy');
  check('real-app reply Copy writes the Markdown source and confirms');

  await scope.locator('.md-code-block .md-code-copy').click();
  await until(async () => (await clipboardText()) === 'const copied = true;\n', 'code copy wrote only the code');
  assert.equal(await clipboardText(), 'const copied = true;\n', 'code-block Copy writes only the code');
  check('real-app code-block Copy writes only the code');

  await copyAction.focus();
  await page.keyboard.press('Enter');
  await until(async () => (await clipboardText()) === answer, 'keyboard Enter copied the reply');
  check('real-app keyboard Enter copies the reply');
  await until(async () => (await copyAction.textContent()) === 'Copy', 'copy label reset');

  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 420]) {
      for (const locale of ['en', 'zh-CN']) {
        const snapshot = await request('runtime.snapshot');
        await request('settings.update', { patch: { language: locale, theme }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
        await app.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0].setContentSize(nextWidth, 900), width);
        await until(async () => (await scope.locator('article.has-reply-actions').count()) > 0, `${locale}/${theme}/${width} reply`);
        await page.mouse.move(4, 4);
        await reply.hover();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('article.has-reply-actions .chat-message-actions')).opacity === '1');
        await shot(`reply-copy-${theme}-${width}-${locale}.png`);
        const label = await copyAction.textContent();
        assert.equal(label, locale === 'zh-CN' ? '复制' : 'Copy', `${locale} reply label`);
        const codeLabel = await scope.locator('.md-code-copy').first().getAttribute('title');
        assert.equal(codeLabel, locale === 'zh-CN' ? '复制代码' : 'Copy code', `${locale} code label`);
        const overflow = await scope.locator('.chat-log-shell').evaluate(element => element.scrollWidth - element.clientWidth);
        assert.ok(overflow <= 1, `${locale}/${theme}/${width} has no horizontal overflow (${overflow})`);
      }
    }
  }
  check('light/dark, en/zh-CN, wide and 420 px matrix shows the copy row without overflow');

  assert.deepEqual(report.errors, [], report.errors.join('\n'));
  report.passed = true;
} catch (error) { report.errors.push(error instanceof Error ? error.stack || error.message : String(error)); if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {}); process.exitCode = 1; }
finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
  console.log(report.passed ? 'REPLY COPY REAL-APP QA PASSED' : `REPLY COPY REAL-APP QA FAILED\n${report.errors.join('\n')}`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
