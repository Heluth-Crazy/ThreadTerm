// Real-app prompt-queue QA.  It uses only the local Queue Echo ACP fixture;
// PATH deliberately contains no installed agent CLI.  Do not run this from CI
// until runtime/target-qa has been built by the owner of that binary.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs'; // Desktop 1, never steals focus.

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const fixture = join(root, 'qa/fixtures/prompt-queue-echo-acp');
const out = join(root, 'qa/results/prompt-queue');
const scratch = await mkdtemp(join(tmpdir(), 'tt-prompt-queue-'));
const appDir = join(scratch, 'app');
const keep = process.argv.includes('--keep');
const report = { passed: false, scratch, checks: [], errors: [], notes: [] };
let app, page;

const delay = ms => new Promise(done => setTimeout(done, ms));
const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 25_000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch { /* runtime is still catching up */ }
    if (Date.now() >= end) throw Error(`Timed out: ${label}`);
    await delay(125);
  }
}
const shot = async name => { await delay(150); await page.screenshot({ path: join(out, name) }); };
const transcript = async sessionId => (await request('chat.snapshot', { sessionId })).items;
const userTexts = async sessionId => (await transcript(sessionId)).filter(item => item.role === 'user').flatMap(item => item.parts).filter(part => part.type === 'text').map(part => part.text);
const queue = sessionId => request('chat.queue.read', { sessionId });
const composer = () => page.locator('.chat-compose-shell textarea');
const send = () => page.locator('.chat-compose-send[type="submit"]');
const queueRoot = () => page.locator('[data-testid="chat-queue"], .chat-queue').first();

async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) {
    await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  }
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-prompt-queue-qa', version: '0.1.0', main: 'main.cjs' }));
}
async function openSecondRenderer() {
  const second = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, args) => {
    const window = new BrowserWindow({ show: false, webPreferences: { preload: args.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
    void window.loadFile(args.index);
  }, { preload: join(appDir, 'preload.cjs'), index: join(appDir, 'renderer', 'index.html') });
  return second;
}
async function enableFixture() {
  await until(async () => (await request('plugin.list')).plugins.find(plugin => plugin.id === 'prompt-queue-echo-acp'), 'prompt queue fixture discovered');
  await request('plugin.setEnabled', { pluginId: 'prompt-queue-echo-acp', enabled: true, operationId: randomUUID() });
  await until(async () => (await request('provider.list')).find(provider => provider.id === 'queue-echo' && provider.chat), 'Queue Echo enabled');
}
async function submitFromComposer(text) {
  const box = composer();
  await box.fill(text);
  await box.press('Enter');
  await until(async () => !(await box.inputValue()), `composer clears for ${text}`);
}
async function waitForQueue(sessionId, count) {
  return until(async () => { const value = await queue(sessionId); return value.items.length === count ? value : undefined; }, `queue has ${count} item(s)`);
}

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; Claude must build runtime/target-qa before running this QA`);
  assert.ok(existsSync(join(fixture, 'threadterm-plugin.json')), 'missing Prompt Queue Echo fixture');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await buildApp();
  const plugins = join(scratch, 'plugins');
  cpSync(fixture, join(plugins, 'prompt-queue-echo-acp'), { recursive: true });

  // Remove every inherited spelling of PATH before adding only the three safe
  // directories needed by Electron, Node and Git's helper executable.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  const gitCmd = join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd');
  const safePath = [dirname(process.execPath), gitCmd, join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';');
  env.PATH = safePath;
  Object.assign(env, {
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-prompt-queue-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_V3_PLUGIN_DIRS: plugins,
    THREADTERM_ECHO_STORE_DIR: join(scratch, 'echo-store'),
  });
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor({ timeout: 45_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const initial = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });
  check('isolated profile launched with notifications disabled and a restricted PATH');
  await enableFixture();

  const work = join(scratch, 'work');
  await mkdir(work, { recursive: true });
  const session = await request('session.create', { cwd: work, title: 'Prompt queue QA', provider: 'queue-echo', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await composer().waitFor();
  await until(async () => (await composer().isEnabled()) ? true : undefined, 'Queue Echo composer enabled');

  // While the fixture holds the first turn open, composer Enter must enqueue.
  await submitFromComposer('slow:10000 seed');
  await until(async () => (await request('runtime.snapshot')).sessions.find(item => item.id === session.id)?.status === 'running', 'slow turn running');
  await until(async () => /queue|加入队列|队列/i.test((await send().innerText()).trim()) ? true : undefined, 'active-turn composer switches Send to Queue');
  await submitFromComposer('queue one');
  await submitFromComposer('queue two');
  await submitFromComposer('queue three');
  let queued = await waitForQueue(session.id, 3);
  assert.deepEqual(queued.items.map(item => item.text), ['queue one', 'queue two', 'queue three']);
  await queueRoot().waitFor();
  await shot('01-queued.png');

  // Exercise the visible row controls.  The data attributes are part of the
  // queue component so text labels remain fully localizable.
  const rows = queueRoot().locator('[data-queue-item-id], .chat-queue-item');
  await rows.nth(1).getByRole('button', { name: /edit/i }).click();
  const edit = rows.nth(1).locator('textarea');
  await edit.fill('queue two edited');
  await edit.press('Control+Enter');
  await until(async () => (await queue(session.id)).items[1]?.text === 'queue two edited', 'edited queue item');
  await rows.nth(2).getByRole('button', { name: /move.*up/i }).click();
  await until(async () => (await queue(session.id)).items.map(item => item.text).join('|') === 'queue one|queue three|queue two edited', 'moved item');
  // Click only once the rows show the new order (the runtime answers before React re-renders).
  await until(async () => /queue three/.test(await rows.nth(1).innerText()), 'queue rows show the moved order');
  await rows.nth(1).getByRole('button', { name: /delete/i }).click();
  queued = await waitForQueue(session.id, 2);
  assert.deepEqual(queued.items.map(item => item.text), ['queue one', 'queue two edited']);
  check('Queue UI edits, moves, and deletes an item while the turn is active');

  await until(async () => (await userTexts(session.id)).includes('queue two edited') ? true : undefined, 'queue drains after completed turn', 35_000);
  assert.deepEqual((await userTexts(session.id)).slice(-3), ['slow:10000 seed', 'queue one', 'queue two edited']);
  assert.equal((await queue(session.id)).items.length, 0);
  check('queue dispatches the retained items once and in edited order');

  // Stop deliberately pauses the durable queue. Resume is a user action.
  await submitFromComposer('slow:10000 stop target');
  await until(async () => (await request('runtime.snapshot')).sessions.find(item => item.id === session.id)?.status === 'running', 'second slow turn running');
  await submitFromComposer('after stop');
  await page.locator('.chat-compose-send.is-stop').click();
  await until(async () => { const value = await queue(session.id); return value.paused && value.pauseReason === 'stopped' ? value : undefined; }, 'queue paused by Stop');
  await until(async () => /Paused after stopping|停止后已暂停/.test(await queueRoot().innerText()), 'queue exposes a text banner for the Stop pause');
  await shot('02-stopped.png');
  await queueRoot().getByRole('button', { name: /resume queue/i }).click();
  await until(async () => (await userTexts(session.id)).includes('after stop') ? true : undefined, 'resumed queue dispatch', 30_000);
  check('Stop keeps queued work, shows a stopped pause, and Resume sends it');

  // A genuine ACP permission request keeps the next queued item unsent until
  // approval completes the turn. The approval itself is answered through UI.
  await submitFromComposer('approval please');
  await until(async () => (await page.locator('.chat-approval-card').count()) > 0 ? true : undefined, 'ACP approval card');
  await submitFromComposer('after approval');
  await waitForQueue(session.id, 1);
  await delay(500);
  assert.equal((await userTexts(session.id)).includes('after approval'), false, 'queue is blocked by approval');
  await shot('03-approval-blocked.png');
  await page.locator('.chat-approval-card').getByRole('button', { name: /allow/i }).first().click();
  await until(async () => (await userTexts(session.id)).includes('after approval') ? true : undefined, 'queue resumes after approval turn', 30_000);
  check('pending approval blocks dispatch until it is answered');

  // A second renderer owns a separate bridge and must observe the same
  // runtime-owned queue, without creating another queue or dispatching it.
  await submitFromComposer('slow:10000 shared seed');
  await until(async () => (await request('runtime.snapshot')).sessions.find(item => item.id === session.id)?.status === 'running', 'shared slow turn');
  await submitFromComposer('shared queue item');
  const second = await openSecondRenderer();
  await second.waitForFunction(() => Boolean(window.threadterm));
  const shared = await second.evaluate(id => window.threadterm.request('chat.queue.read', { sessionId: id }), session.id);
  assert.equal(shared.items.length, 1);
  assert.equal(shared.items[0].text, 'shared queue item');
  await shot('04-shared-queue.png');
  check('a second renderer reads the same durable queue');
  await second.close();
  await until(async () => (await userTexts(session.id)).includes('shared queue item') ? true : undefined, 'shared queued item dispatch', 30_000);
  assert.deepEqual(report.errors, [], report.errors.join('\n'));
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
} finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  report.completedAt = new Date().toISOString();
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (!keep) await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
  console.log(report.passed ? 'PROMPT QUEUE QA PASSED' : `PROMPT QUEUE QA FAILED\n${report.errors.join('\n')}`);
  process.exitCode = report.passed ? 0 : 1;
}
