// Real-app lifetime acceptance QA for browser-preview authority. Run only after
// `runtime` and the renderer are rebuilt: node qa/browser-preview-lifetime.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target/debug/threadterm-v3-runtime.exe');
const fixture = join(root, 'qa/fixtures/browser-plugins');
const out = join(root, 'qa/results/browser-preview-lifetime');
const scratch = await mkdtemp(join(tmpdir(), 'tt-browser-preview-lifetime-'));
const server = createServer((_, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<main id="browser-preview-lifetime">Browser preview lifetime QA</main>');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const previewUrl = `http://127.0.0.1:${server.address().port}`;
const report = {
  passed: false,
  scratch,
  checks: [],
  screenshots: [],
  errors: [],
  limitations: ['Uses deterministic local Codex and loopback HTTP fixtures. A second independent desktop process is not started, so cross-window lease theft remains covered by runtime tests.'],
};
let app;
let page;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const request = (method, params = {}) => page.evaluate(([m, p]) => window.threadterm.request(m, p), [method, params]);
async function until(predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { const value = await predicate(); if (value) return value; } catch { /* retry asynchronous UI/runtime work */ }
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await sleep(120);
  }
}
async function buildApplication(directory) {
  await mkdir(directory, { recursive: true });
  for (const name of ['main', 'preload']) {
    await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(directory, `${name}.cjs`), logLevel: 'error' });
  }
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(directory, 'renderer'), emptyOutDir: true } });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'browser-preview-lifetime-qa', version: '1', main: 'main.cjs' }));
}
async function events(path) {
  return (await readFile(path, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
const browserTabs = () => page.locator('.browser-page-tab');
function countUrl(layout, url) {
  if (!layout || typeof layout !== 'object') return 0;
  if (layout.kind === 'split') return countUrl(layout.first, url) + countUrl(layout.second, url);
  return Array.isArray(layout.tabs) ? layout.tabs.filter(tab => tab.kind === 'web' && tab.url === url).length : 0;
}
async function savedUrlCount(url) {
  const snapshot = await request('runtime.snapshot');
  return snapshot.workspaces.reduce((total, workspace) => total + countUrl(workspace.layout, url), 0);
}
async function selectChat(title) {
  const row = page.locator('.sess-row').filter({ hasText: title }).first();
  await row.waitFor({ state: 'visible' });
  await row.click();
  await page.locator('.chat-compose-shell textarea').filter({ visible: true }).first().waitFor();
}
async function leaveChat() {
  const all = page.locator('.nav-item').filter({ hasText: /^All terminals$/ }).first();
  await all.waitFor({ state: 'visible' });
  await all.click();
  await until(async () => (await page.locator('.chat-compose-shell textarea').filter({ visible: true }).count()) === 0, 'chat detaches from the visible desktop');
}
async function waitForSettled(sessionId) {
  await until(async () => {
    const snapshot = await request('runtime.snapshot');
    const session = snapshot.sessions.find(item => item.id === sessionId);
    return Boolean(session && !['running', 'waiting'].includes(session.status));
  }, 'previous native turn settles in the runtime');
  await until(async () => (await page.locator('.chat-first-response-wait').count()) === 0, 'previous first response indicator clears');
}
async function beginPreview(eventFile, sessionId, control) {
  await waitForSettled(sessionId);
  const before = await events(eventFile);
  const present = before.filter(entry => entry.name === 'mcp.present').length;
  const errors = before.filter(entry => entry.name === 'mcp.error').length;
  const composer = page.locator('.chat-compose-shell textarea').filter({ visible: true }).first();
  await until(async () => !(await composer.isDisabled()), 'new Chat composer becomes writable');
  await composer.fill(`qa-preview ${JSON.stringify(control)}`);
  const send = page.locator('.chat-compose-send[type=submit]').filter({ visible: true }).first();
  await until(() => send.isEnabled(), 'filled composer is writable');
  await send.click();
  return {
    async result(label = control.requestId) {
      return until(async () => {
        const rows = await events(eventFile);
        const newPresent = rows.filter(entry => entry.name === 'mcp.present');
        if (newPresent.length > present) return { kind: 'present', detail: newPresent.at(-1).detail };
        const newErrors = rows.filter(entry => entry.name === 'mcp.error');
        if (newErrors.length > errors) return { kind: 'error', detail: newErrors.at(-1).detail };
        return undefined;
      }, `fixture result for ${label}`);
    },
  };
}
async function createChat(project, cwd, title) {
  return request('session.create', { projectId: project.id, cwd, provider: 'codex', mode: 'chat', title, operationId: randomUUID() });
}

try {
  assert.ok(existsSync(runtime), `missing current runtime: ${runtime}`);
  await mkdir(out, { recursive: true });
  const appDir = join(scratch, 'app');
  const plugins = join(scratch, 'plugins');
  const bin = join(scratch, 'bin');
  const work = join(scratch, 'work');
  const eventFile = join(scratch, 'events.jsonl');
  await buildApplication(appDir);
  await mkdir(bin, { recursive: true });
  await mkdir(work, { recursive: true });
  cpSync(fixture, join(plugins, 'browser-preview-acp-qa'), { recursive: true });
  await writeFile(join(bin, 'codex.cmd'), `@"${process.execPath}" "${join(fixture, 'fake-codex-browser.cjs')}" %*\r\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'home', 'userprofile', 'codex_home', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe'].includes(key.toLowerCase())));
  Object.assign(env, {
    Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), CODEX_HOME: join(scratch, 'home', '.codex'),
    THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-browser-lifetime-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PLUGIN_DIRS: plugins,
    THREADTERM_QA_BROWSER_EVENTS: eventFile, THREADTERM_QA_BROWSER_CWD: work, THREADTERM_QA_BROWSER_URL: previewUrl,
  });
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 15_000 });
  let snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  const project = await request('project.add', { path: work, name: 'Preview lifetime QA', operationId: randomUUID() });
  await until(async () => (await request('provider.list')).some(provider => provider.id === 'codex' && provider.chat), 'isolated Codex provider');

  const saved = await createChat(project, work, 'Saved preview owner');
  await selectChat('Saved preview owner');
  const initial = await beginPreview(eventFile, saved.id, { requestId: 'saved', path: 'saved', title: 'Saved preview' });
  const first = await initial.result();
  assert.equal(first.kind, 'present', 'initial request must receive an actual presentation acknowledgement');
  assert.equal(first.detail.isError, false);
  assert.equal(first.detail.state, 'presented');
  await until(async () => (await browserTabs().count()) === 1, 'saved browser tab');
  assert.equal(await savedUrlCount(`${previewUrl}/saved`), 1, 'saved tab is persisted in a workspace layout');
  check('a saved preview tab exists before revocation');

  const delayed = await beginPreview(eventFile, saved.id, { requestId: 'revoke-pending', path: 'revoke', title: 'Revoked preview', delayMs: 1_800 });
  await page.locator('.chat-first-response-wait').waitFor({ state: 'visible' });
  await request('plugin.setEnabled', { pluginId: 'codex-preview', enabled: false, operationId: randomUUID() });
  const revoked = await delayed.result();
  assert.equal(revoked.kind, 'present', 'the fixture records an MCP tool response');
  assert.equal(revoked.detail.isError, true, 'the disabled binding must deny an already-open provider process');
  assert.equal(await browserTabs().count(), 1, 'revocation preserves saved user-owned tabs and creates no new tab');
  assert.equal(await savedUrlCount(`${previewUrl}/saved`), 1, 'revocation retains the saved tab in its workspace layout');
  await waitForSettled(saved.id);
  const denied = await beginPreview(eventFile, saved.id, { requestId: 'deny-after-disable', path: 'deny', title: 'Denied preview' });
  const deniedResult = await denied.result();
  assert.equal(deniedResult.kind, 'present');
  assert.equal(deniedResult.detail.isError, true, 'new preview use is denied while its binding is disabled');
  assert.equal(await browserTabs().count(), 1);
  check('plugin disable denies pending and subsequent old-provider preview calls without removing saved tabs');

  await request('plugin.setEnabled', { pluginId: 'codex-preview', enabled: true, operationId: randomUUID() });
  await waitForSettled(saved.id);
  const oldGrant = await beginPreview(eventFile, saved.id, { requestId: 'stale-after-reenable', path: 'stale', title: 'Stale preview' });
  const oldGrantResult = await oldGrant.result();
  assert.equal(oldGrantResult.kind, 'present');
  assert.equal(oldGrantResult.detail.isError, true, 'reenabling does not revive a revoked provider-open grant');
  assert.equal(await savedUrlCount(`${previewUrl}/saved`), 1, 'the stale provider cannot alter saved tabs');
  check('reenabling requires a new provider open; it does not revive revoked authority');

  const detached = await createChat(project, work, 'Detached preview owner');
  await selectChat('Detached preview owner');
  const noUi = await beginPreview(eventFile, detached.id, { requestId: 'no-ui', path: 'no-ui', title: 'No UI preview', delayMs: 1_500 });
  await page.locator('.chat-first-response-wait').waitFor({ state: 'visible' });
  await leaveChat();
  const unavailable = await noUi.result();
  assert.equal(unavailable.kind, 'present', 'detached target returns a structured preview result');
  assert.equal(unavailable.detail.state, 'unavailable', 'a request delivered after desktop detachment is unavailable');
  assert.equal(await browserTabs().count(), 0, 'detached workspace exposes no hidden browser surface');
  assert.equal(await savedUrlCount(`${previewUrl}/saved`), 1, 'detaching another Chat cannot delete the saved tab');
  assert.equal(await savedUrlCount(`${previewUrl}/no-ui`), 0, 'unavailable work is never saved into a workspace');
  await selectChat('Detached preview owner');
  await sleep(500);
  assert.equal(await savedUrlCount(`${previewUrl}/saved`), 1, 'reattaching a different Chat preserves prior saved work');
  assert.equal(await savedUrlCount(`${previewUrl}/no-ui`), 0, 'reattach never replays an unavailable request');
  const reattached = await beginPreview(eventFile, detached.id, { requestId: 'after-reattach', path: 'reattach', title: 'Reattached preview' });
  const reattachedResult = await reattached.result();
  assert.equal(reattachedResult.kind, 'present');
  assert.equal(reattachedResult.detail.state, 'presented');
  await until(async () => (await savedUrlCount(`${previewUrl}/reattach`)) === 1, 'explicit post-reattach request persists once');
  check('desktop detach returns unavailable, reattach does not replay, and a new explicit request presents normally');

  await selectChat('Detached preview owner');
  const slow = await beginPreview(eventFile, detached.id, { requestId: 'slow', path: 'slow', title: 'Slow preview', delayMs: 4_000 });
  await page.locator('.chat-first-response-wait').waitFor({ state: 'visible' });
  const controlSnapshot = await request('runtime.snapshot');
  assert.ok(controlSnapshot.sessions.some(session => session.id === detached.id), 'runtime control calls remain available while a preview waits');
  const terminal = await request('session.create', { projectId: project.id, cwd: work, provider: 'shell', mode: 'terminal', executable: 'cmd.exe', args: ['/Q', '/K'], title: 'Preview lifetime terminal', operationId: randomUUID() });
  await request('session.stop', { sessionId: terminal.id, operationId: randomUUID() });
  const concurrent = await createChat(project, work, 'Concurrent preview owner');
  assert.equal(concurrent.provider, 'codex', 'a second Chat can be created while preview acknowledgment waits');
  const slowResult = await slow.result();
  assert.equal(slowResult.kind, 'present');
  assert.equal(slowResult.detail.state, 'presented');
  check('a waiting preview does not block runtime controls, terminal lifecycle, or creation of another Chat');
  await page.screenshot({ path: join(out, 'lifetime-light-en.png'), animations: 'disabled' });
  report.screenshots.push('lifetime-light-en.png');
  assert.deepEqual(report.errors, [], report.errors.join('\n'));
  report.passed = true;
} catch (error) {
  report.errors.push(error?.stack ?? String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await new Promise(done => server.close(done));
  report.completedAt = new Date().toISOString();
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(report.passed ? 'BROWSER PREVIEW LIFETIME QA PASSED' : `BROWSER PREVIEW LIFETIME QA FAILED\n${report.errors.join('\n')}`);
  process.exitCode = report.passed ? 0 : 1;
}
