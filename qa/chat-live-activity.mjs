// Real-app Electron evidence for a live Chat turn: tools -> text -> tools -> text.
// Run after building runtime/Cargo.toml --bins with THREADTERM_V3_RUNTIME_BIN set.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { sendChatPrompt } from './lib/chat-send.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

const root = resolve(import.meta.dirname, '..');
assert.ok(process.env.THREADTERM_V3_RUNTIME_BIN, 'set THREADTERM_V3_RUNTIME_BIN to the isolated worktree runtime');
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN);
const fixture = join(root, 'qa/fixtures/chat-live-activity-acp');
const out = join(root, 'qa/results/chat-live-activity');
let scratch, appDir, plugins, work;
const report = { passed: false, screenshots: [], checks: [], errors: [] };
let app, page, releaseLock;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const until = async (probe, label, timeout = 30_000) => {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const value = await probe(); if (value) return value; } catch (error) { last = error; } await delay(100); }
  throw Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
};
async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), '{"name":"chat-live-activity-qa","version":"1.0.0","main":"main.cjs"}');
}
try {
  assert.ok(existsSync(runtime), `missing runtime: ${runtime}`);
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  scratch = await mkdtemp(join(out, 'scratch-'));
  appDir = join(scratch, 'app'); plugins = join(scratch, 'plugins'); work = join(scratch, 'work');
  await Promise.all([mkdir(plugins, { recursive: true }), mkdir(work, { recursive: true })]);
  const plugin = join(plugins, 'chat-live-activity-acp'); cpSync(fixture, plugin, { recursive: true });
  await writeFile(join(plugin, 'threadterm-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'chat-live-activity-acp', name: 'Chat live activity (QA fixture)', version: '1.0.0', publisher: 'ThreadTerm QA', description: 'Offline live Chat activity fixture.', contributes: { agents: [{ id: 'chat-live-activity', name: 'Chat live activity', command: 'node', args: ['{pluginDir}/agent.mjs'], versionArgs: ['--version'], terminal: { args: [] }, chat: { protocol: 'acp', args: ['--acp'] } }] } }, null, 2));
  await buildApp();
  await mkdir(dirname(join(root, 'runtime/target-qa/vdesk.exe')), { recursive: true });
  const env = { ...process.env, THREADTERM_QA_PROVIDER_BIN: dirname(process.execPath), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-chat-live-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PLUGIN_DIRS: plugins };
  releaseLock = await acquireElectronQaLock();
  app = await electron.launch({ args: [appDir], cwd: root, env, timeout: 60_000 }); page = await app.firstWindow({ timeout: 45_000 });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.locator('.app-shell').waitFor(); await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
  const initial = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });
  await until(async () => (await request('plugin.list')).plugins.some(row => row.id === 'chat-live-activity-acp'), 'fixture discovery');
  await request('plugin.setEnabled', { pluginId: 'chat-live-activity-acp', enabled: true, operationId: randomUUID() });
  await until(async () => (await request('provider.list')).some(row => row.id === 'chat-live-activity' && row.chat), 'fixture provider');
  const project = await request('project.add', { path: work, name: 'Live activity QA', operationId: randomUUID() });
  const chat = await request('session.create', { projectId: project.id, cwd: work, title: 'Live activity QA', provider: 'chat-live-activity', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: chat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const scope = page.locator(`[data-testid="session-chat-${chat.id}"]`), composer = scope.locator('.chat-compose-shell textarea');
  await until(() => composer.isEnabled(), 'composer');
  await sendChatPrompt({ composer, sendButton: scope.locator('.chat-compose-send[type=submit]'), text: 'Show live activity.', readSnapshot: () => request('chat.snapshot', { sessionId: chat.id }), readConnection: () => request('chat.connection', { sessionId: chat.id }) });
  const drawers = scope.locator('details.chat-fold');
  await until(async () => await drawers.count() === 1 && await scope.getByText('First live update.', { exact: true }).count(), 'first text after first tool');
  assert.equal(await scope.locator('.chat-first-response-wait').count(), 0, 'interim text clears the first-response placeholder');
  assert.equal(await scope.locator('.chat-live-activity').count(), 1, 'interim text leaves one compact working status');
  assert.equal(await scope.locator('.chat-live-elapsed').count(), 1, 'working status includes elapsed time when the turn start is known');
  const firstDrawer = drawers.first();
  if (!await firstDrawer.evaluate(node => node.open)) await firstDrawer.locator('> summary').click();
  assert.equal(await firstDrawer.evaluate(node => node.open), true, 'the work fold can be expanded before later live activity');
  await page.screenshot({ path: join(out, 'live-text-wait-light.png'), animations: 'disabled' }); report.screenshots.push('live-text-wait-light.png');
  // While a new unphased text is the newest part it is the answer, shown outside the fold.
  const firstText = scope.getByText('First live update.', { exact: true });
  const foldBox = await firstDrawer.boundingBox(), textBox = await firstText.boundingBox();
  assert.ok(foldBox && textBox && foldBox.y < textBox.y, 'the work fold sits above the interim text');
  await until(async () => await drawers.first().locator('.chat-tool-entry[data-tool-status="running"]').count() > 0, 'trailing running tool');
  assert.equal(await drawers.count(), 1, 'the following call joins the same fold instead of opening another');
  assert.equal(await firstDrawer.evaluate(node => node.open), true, 'the fold keeps its expansion state across the update');
  assert.equal(await firstDrawer.locator('.chat-fold-step.is-note').filter({ hasText: 'First live update.' }).count(), 1, 'the absorbed text becomes a step of that fold (R1 one accepted jump)');
  assert.equal(await scope.getByText('First live update.', { exact: true }).count(), 1, 'the text is not duplicated outside');
  assert.equal(await scope.locator('.chat-live-activity').count(), 0, 'the live fold replaces the working status');
  await page.screenshot({ path: join(out, 'live-running-tool-light.png'), animations: 'disabled' }); report.screenshots.push('live-running-tool-light.png');
  // Thinking between calls is a row inside the same fold: no second fold, no loose "Thought process" rows.
  const looseThinking = () => scope.locator('.v3-thinking').count();
  let mostDrawers = 0;
  try {
    await until(async () => { mostDrawers = Math.max(mostDrawers, await drawers.count()); return await scope.getByText('Second live update.', { exact: true }).count() > 0; }, 'second reply after thinking and two calls');
  } finally {
    report.liveStructure = await scope.locator('.v3-chat-log').evaluate(log => [...log.querySelectorAll('details.chat-fold, .v3-thinking, .v3-message-text')]
      .map(node => node.nodeName === 'DETAILS' ? `fold:${node.querySelector('.chat-tool-current-action')?.textContent}` : node.classList.contains('v3-thinking') ? 'thinking' : `text:${node.textContent?.slice(0, 40)}`));
  }
  assert.equal(mostDrawers, 1, 'the whole working segment stays one fold');
  assert.equal(await looseThinking(), 0, 'thinking is never a separate transcript row');
  await drawers.first().locator('> summary').click();
  await until(async () => await drawers.first().locator('.chat-fold-step.is-thinking').count() >= 2, 'thoughts listed in the open fold');
  assert.deepEqual(await drawers.first().locator('.chat-tool-entries > *').evaluateAll(nodes => nodes.map(node => node.classList.contains('chat-tool-entry') ? 'tool' : node.classList.contains('is-thinking') ? 'thought' : 'note')), ['tool', 'note', 'thought', 'tool', 'thought', 'tool'], 'steps keep their order inside the fold');
  await page.screenshot({ path: join(out, 'live-thinking-in-drawer-light.png'), animations: 'disabled' }); report.screenshots.push('live-thinking-in-drawer-light.png');
  await drawers.first().locator('> summary').click();
  report.checks.push('thinking between live calls stays in one fold and is listed in order when the fold is open');
  await until(async () => await scope.getByText('Second live update.', { exact: true }).count() && await scope.locator('.chat-live-activity').count() === 1, 'second text working status');
  assert.equal(await drawers.first().locator('.chat-tool-entry[data-tool-status="running"]').count(), 0, 'the fold stops claiming to run after its text');
  report.checks.push('live activity keeps one fold per working segment and only its newest step presents running work');
  await until(async () => (await request('runtime.snapshot')).sessions.find(row => row.id === chat.id)?.status === 'idle', 'turn settlement');
  assert.equal(await scope.locator('.chat-live-activity').count(), 0, 'working status leaves when the turn settles');
  assert.equal(await drawers.count(), 1, 'settled turn keeps its single work fold');
  const darkSnapshot = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'zh-CN', theme: 'dark' }, expectedRevision: darkSnapshot.settings.revision, operationId: randomUUID() });
  const darkChat = await request('session.create', { projectId: project.id, cwd: work, title: 'Live activity dark QA', provider: 'chat-live-activity', mode: 'chat', operationId: randomUUID() });
  await request('session.present', { sessionId: darkChat.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const darkScope = page.locator(`[data-testid="session-chat-${darkChat.id}"]`), darkComposer = darkScope.locator('.chat-compose-shell textarea');
  await until(() => darkComposer.isEnabled(), 'dark composer');
  await sendChatPrompt({ composer: darkComposer, sendButton: darkScope.locator('.chat-compose-send[type=submit]'), text: 'Show live activity in dark Chinese.', readSnapshot: () => request('chat.snapshot', { sessionId: darkChat.id }), readConnection: () => request('chat.connection', { sessionId: darkChat.id }) });
  await until(async () => await darkScope.getByText('First live update.', { exact: true }).count() && await darkScope.locator('.chat-live-activity').count() === 1, 'dark Chinese live text');
  await page.screenshot({ path: join(out, 'live-text-wait-dark-zh.png'), animations: 'disabled' }); report.screenshots.push('live-text-wait-dark-zh.png');
  report.checks.push('light English and dark Chinese live text phases render with a compact working status');
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.errors.push(error.stack || String(error)); process.exitCode = 1; try { await page?.screenshot({ path: join(out, 'failure.png'), animations: 'disabled' }); } catch {} }
finally {
  try { await page?.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })); } catch {}
  try { await app?.close(); } catch {}
  try { await releaseLock?.(); } catch {}
  await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  console.log(JSON.stringify(report, null, 2));
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
