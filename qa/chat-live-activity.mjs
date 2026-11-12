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
  const drawers = scope.locator('.chat-tool-activity');
  await until(async () => await drawers.count() === 1 && await scope.getByText('First live update.', { exact: true }).count(), 'first text after first tool');
  assert.equal(await scope.locator('.chat-first-response-wait').count(), 0, 'interim text clears the first-response placeholder');
  assert.equal(await scope.locator('.chat-live-activity').count(), 1, 'interim text leaves one compact working status');
  assert.equal(await scope.locator('.chat-live-elapsed').count(), 1, 'working status includes elapsed time when the turn start is known');
  const firstDrawer = drawers.first();
  if (!await firstDrawer.evaluate(node => node.open)) await firstDrawer.locator('> summary').click();
  assert.equal(await firstDrawer.evaluate(node => node.open), true, 'the first drawer can be expanded before later live activity');
  await page.screenshot({ path: join(out, 'live-text-wait-light.png'), animations: 'disabled' }); report.screenshots.push('live-text-wait-light.png');
  await until(async () => await drawers.count() === 2 && await drawers.nth(1).locator('.is-running').count() > 0, 'trailing running tool');
  const firstText = scope.getByText('First live update.', { exact: true });
  const [firstBox, textBox, secondBox] = await Promise.all([firstDrawer.boundingBox(), firstText.boundingBox(), drawers.nth(1).boundingBox()]);
  assert.ok(firstBox && textBox && secondBox && firstBox.y < textBox.y && textBox.y < secondBox.y, 'first drawer, interim text, and trailing drawer stay in transcript order');
  assert.equal(await firstDrawer.evaluate(node => node.open), true, 'the original drawer keeps its expansion state after the split');
  assert.equal(await drawers.nth(0).locator('.is-running').count(), 0, 'earlier drawer is no longer running');
  assert.equal(await scope.locator('.chat-live-activity').count(), 0, 'running trailing drawer replaces the working status');
  await page.screenshot({ path: join(out, 'live-running-tool-light.png'), animations: 'disabled' }); report.screenshots.push('live-running-tool-light.png');
  // Thinking between calls stays inside the trailing drawer: no third drawer, no loose "Thought process" rows.
  const looseThinking = () => scope.locator('.v3-thinking').evaluateAll(nodes => nodes.filter(node => !node.closest('.chat-tool-activity')).length);
  let mostDrawers = 0;
  try {
    await until(async () => { mostDrawers = Math.max(mostDrawers, await drawers.count()); return await scope.getByText('Second live update.', { exact: true }).count() > 0; }, 'second reply after thinking and two calls');
  } finally {
    report.liveStructure = await scope.locator('.v3-chat-log').evaluate(log => [...log.querySelectorAll('.chat-tool-activity, .v3-thinking, .v3-message-text')]
      .map(node => node.classList.contains('chat-tool-activity') ? `drawer:${node.querySelector('.chat-tool-current-action')?.textContent}` : node.classList.contains('v3-thinking') ? `thinking${node.closest('.chat-tool-activity') ? '(in drawer)' : ''}` : `text:${node.textContent?.slice(0, 40)}`));
  }
  assert.equal(mostDrawers, 2, 'thinking between calls never splits the live drawer');
  assert.equal(await looseThinking(), 0, 'thinking before and between calls is not a separate transcript row');
  await drawers.nth(1).locator('> summary').click();
  await until(async () => await drawers.nth(1).locator('.chat-tool-thought').count() === 2, 'thoughts listed in the open drawer');
  assert.deepEqual(await drawers.nth(1).locator('.chat-tool-entries > [role="listitem"]').evaluateAll(nodes => nodes.map(node => node.classList.contains('chat-tool-thought') ? 'thought' : 'tool')), ['thought', 'tool', 'thought', 'tool'], 'thoughts and calls keep their order inside the drawer');
  await page.screenshot({ path: join(out, 'live-thinking-in-drawer-light.png'), animations: 'disabled' }); report.screenshots.push('live-thinking-in-drawer-light.png');
  await drawers.nth(1).locator('> summary').click();
  report.checks.push('thinking between live calls stays in one drawer and is listed in order when the drawer is open');
  await until(async () => await scope.getByText('Second live update.', { exact: true }).count() && await scope.locator('.chat-live-activity').count() === 1, 'second text working status');
  assert.equal(await drawers.nth(1).locator('.is-running').count(), 0, 'second drawer stops claiming to run after its text');
  report.checks.push('live activity splits around interim assistant text and only the trailing drawer presents running work');
  await until(async () => (await request('runtime.snapshot')).sessions.find(row => row.id === chat.id)?.status === 'idle', 'turn settlement');
  assert.equal(await scope.locator('.chat-live-activity').count(), 0, 'working status leaves when the turn settles');
  assert.equal(await drawers.count(), 1, 'settled turn keeps its folded single-drawer presentation');
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
