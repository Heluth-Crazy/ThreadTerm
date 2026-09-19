import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, copyFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const root = await mkdtemp(join(tmpdir(), 'threadterm-v3-cache-'));
const bin = join(root, 'runtime.exe');
await copyFile(resolve('runtime/target/debug/threadterm-v3-runtime.exe'), bin);
const env = { ...process.env, THREADTERM_V3_DATA: join(root, 'data'), THREADTERM_V3_USER_DATA: join(root, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\threadterm-v3-cache-${process.pid}`, THREADTERM_V3_RUNTIME: bin };
let app, page;
let hits = 0;
const server = createServer((_request, response) => {
  hits++;
  response.writeHead(200, { 'Cache-Control': 'public, max-age=86400', 'Content-Type': 'text/plain' });
  response.end('REBUILDABLE_CACHE_SAMPLE'.repeat(4096));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const cacheUrl = `http://127.0.0.1:${server.address().port}/cache-proof`;
const report = { startedAt: new Date().toISOString(), passed: false, checks: [] };
async function launch() {
  app = await electron.launch({ args: [resolve('.')], env, timeout: 30000 });
  page = await app.firstWindow();
  await page.waitForFunction(() => !!window.threadterm);
  return page;
}
async function stop() {
  if (!app) return;
  await page?.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  app = undefined; page = undefined;
}
async function fetchCache() {
  return app.evaluate(async ({ session }, url) => (await session.defaultSession.fetch(url)).text(), cacheUrl);
}
const snapshot = () => page.evaluate(() => window.threadterm.request('runtime.snapshot', {}));
try {
  await mkdir(join(root, 'project'));
  await writeFile(join(root, 'project', 'keep.txt'), 'on-disk original');
  await launch();
  const project = await page.evaluate(path => window.threadterm.request('project.add', { path, name: 'Cache QA', operationId: crypto.randomUUID() }), join(root, 'project'));
  const draft = await page.evaluate(async projectId => {
    const file = await window.threadterm.request('filesystem.read', { projectId, path: 'keep.txt' });
    return window.threadterm.request('draft.put', { projectId, path: 'keep.txt', content: 'business-data', baseFingerprint: file.fingerprint, expectedRevision: 0, operationId: crypto.randomUUID() });
  }, project.id);
  await app.evaluate(async ({ session }) => session.defaultSession.cookies.set({ url: 'https://cache-qa.invalid', name: 'retain', value: 'business-cookie', expirationDate: Date.now() / 1000 + 86400 }));
  await fetchCache(); await fetchCache();
  assert.equal(hits, 1, 'second HTTP response should come from Chromium cache');
  await page.evaluate(() => window.threadterm.scheduleElectronCacheCleanup(true));
  assert.equal((await snapshot()).settings.electronCacheCleanup?.state, 'scheduled');
  await stop(); await launch();
  const after = await snapshot();
  assert.equal(after.projects.find(item => item.id === project.id)?.name, 'Cache QA');
  const kept = await page.evaluate(projectId => window.threadterm.request('draft.list', { projectId }), project.id);
  assert.ok(kept.some(item => item.id === draft.id && item.content === 'business-data'));
  assert.equal(after.settings.electronCacheCleanup?.state, 'completed');
  const cookies = await app.evaluate(({ session }) => session.defaultSession.cookies.get({ name: 'retain' }));
  assert.equal(cookies[0]?.value, 'business-cookie');
  await fetchCache(); assert.equal(hits, 2, 'scheduled cleanup removes the HTTP cache');
  report.checks.push('scheduled cleanup clears real HTTP cache after a full restart and retains SQLite project/draft and cookies');
  const completedAt = after.settings.electronCacheCleanup.completedAt;
  await stop(); await launch();
  assert.equal((await snapshot()).settings.electronCacheCleanup?.completedAt, completedAt, 'completed action must not run at every startup');
  await fetchCache(); assert.equal(hits, 2, 'completed cleanup is not repeated on the following startup');
  await page.evaluate(() => window.threadterm.scheduleElectronCacheCleanup(true));
  await page.evaluate(() => window.threadterm.scheduleElectronCacheCleanup(false));
  assert.equal((await snapshot()).settings.electronCacheCleanup, undefined);
  await stop(); await launch(); await fetchCache();
  assert.equal(hits, 2, 'cancelled cleanup must retain the HTTP cache after restart');
  assert.equal((await snapshot()).settings.electronCacheCleanup, undefined);
  report.checks.push('completion is consumed once and cancellation persists across restart');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await mkdir('qa/results', { recursive: true });
  await writeFile('qa/results/cache-cleanup-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await stop();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
