import { _electron as electron } from '@playwright/test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { connectPeer } from './pipe-client.mjs';
import assert from 'node:assert/strict';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-v3-floating-'));
const runtime = resolve('runtime/target/debug/threadterm-v3-runtime.exe');
const pipe = `\\\\.\\pipe\\threadterm-v3-floating-${process.pid}-${Date.now()}`;
const env = {
  ...process.env,
  THREADTERM_V3_DATA: join(scratch, 'data'),
  THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: pipe,
  THREADTERM_V3_RUNTIME: runtime,
};
const report = { passed: false, startedAt: new Date().toISOString(), checks: [] };
let app;
let page;
let shutdownCompleted = false;

async function runtimeRequest(method, params) {
  return page.evaluate(({ method, params }) => window.threadterm.request(method, params), { method, params });
}
async function updateSettings(patch) {
  const snapshot = await runtimeRequest('runtime.snapshot', {});
  await runtimeRequest('settings.update', { patch, expectedRevision: snapshot.settings.revision, operationId: crypto.randomUUID() });
  await page.evaluate(() => window.threadterm.desktopPreferences());
}
async function selectSession(id, title) {
  const selector = page.locator('.session-header select[aria-label]');
  if (await selector.count()) await selector.selectOption(id);
  else await page.getByRole('button', { name: new RegExp(title, 'i') }).click();
  await page.getByLabel(/select session|选择会话/i).waitFor();
  await page.waitForFunction((sessionId) => document.querySelector('.session-header select')?.value === sessionId, id);
}
async function openSessionWindow(id, title) {
  await selectSession(id, title);
  const count = app.windows().length;
  const added = app.waitForEvent('window', { predicate: (candidate) => candidate !== page, timeout: 12_000 });
  await page.getByRole('button', { name: /open.*window|打开窗口/i }).click();
  const window = await added;
  await window.waitForFunction(() => !!window.threadterm);
  await window.waitForFunction((sessionId) => new URLSearchParams(location.search).get('sessionId') === sessionId, id);
  assert.equal(app.windows().length, count + 1);
  return window;
}

try {
  await access(runtime);
  await mkdir(join(scratch, 'project'));
  await mkdir('qa/results', { recursive: true });
  app = await electron.launch({ args: [resolve('.')], env, timeout: 30_000 });
  page = await app.firstWindow();
  await page.waitForFunction(() => !!window.threadterm, { timeout: 15_000 });
  const projectPath = join(scratch, 'project');
  const project = await runtimeRequest('project.add', { path: projectPath, name: 'Floating QA', operationId: crypto.randomUUID() });
  const create = async (title) => runtimeRequest('session.create', {
    projectId: project.id, cwd: projectPath, provider: 'shell', mode: 'terminal', title,
    executable: 'cmd.exe', args: ['/Q', '/K'], operationId: crypto.randomUUID(),
  });
  const first = await create('Float QA First');
  const second = await create('Float QA Second');
  const third = await create('Float QA Third');
  await updateSettings({ lightweightMode: false, floatMode: 'cycle' });

  const firstFloat = await openSessionWindow(first.id, 'Float QA First');
  const secondFloat = await openSessionWindow(second.id, 'Float QA Second');
  assert.equal(new URLSearchParams(await secondFloat.evaluate(() => location.search)).get('sessionId'), second.id);
  const countAfterDistinct = app.windows().length;
  await selectSession(first.id, 'Float QA First');
  await page.getByRole('button', { name: /open.*window|打开窗口/i }).click();
  await page.waitForTimeout(250);
  assert.equal(app.windows().length, countAfterDistinct, 'opening the same target reuses its float in cycle mode');
  assert.equal(new URLSearchParams(await firstFloat.evaluate(() => location.search)).get('sessionId'), first.id);
  report.checks.push('cycle mode opens a distinct explicit target and reuses the exact existing target');

  await runtimeRequest('session.present', { sessionId: second.id, placement: 'workspace', presentation: 'focused', operationId: crypto.randomUUID() });
  await page.waitForFunction((sessionId) => document.querySelector('.session-header select')?.value === sessionId, second.id);
  await page.waitForTimeout(200);
  assert.equal(await firstFloat.locator('.session-header select[aria-label]').inputValue(), first.id, 'shared session.present must not retarget a floating renderer');
  report.checks.push('floating renderer ignored shared workspace presentation navigation');

  await updateSettings({ lightweightMode: true, floatMode: 'cycle' });
  const beforeLightweight = app.windows().length;
  await selectSession(first.id, 'Float QA First');
  await page.evaluate((sessionId) => window.threadterm.openWindow({ sessionId }), third.id);
  await page.waitForFunction((sessionId) => document.querySelector('.session-header select')?.value === sessionId, third.id);
  assert.equal(app.windows().length, beforeLightweight, 'lightweight openWindow does not add a BrowserWindow');
  report.checks.push('lightweight openWindow navigated the main window to the requested session without changing float count');

  const fullscreen = page.getByRole('button', { name: /fullscreen terminal|全屏终端/i });
  await fullscreen.click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.titlebar')).display === 'none');
  const beforeEscape = await runtimeRequest('runtime.snapshot', {});
  assert.equal(beforeEscape.sessions.find((item) => item.id === third.id)?.status, 'running');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.titlebar')).display !== 'none');
  const afterEscape = await runtimeRequest('runtime.snapshot', {});
  assert.equal(afterEscape.sessions.find((item) => item.id === third.id)?.status, 'running');
  report.checks.push('terminal fullscreen hid chrome and Escape restored it without ending the active PTY');

  await selectSession(first.id, 'Float QA First');
  await selectSession(second.id, 'Float QA Second');
  await page.keyboard.down('Control'); await page.keyboard.up('Control');
  await page.waitForTimeout(70);
  await page.keyboard.down('Control'); await page.keyboard.up('Control');
  await page.waitForFunction((sessionId) => document.querySelector('.session-header select')?.value === sessionId, first.id);
  report.checks.push('double Ctrl switched from the current session to the last active session');

  for (const session of [first, second, third])
    await runtimeRequest('session.stop', { sessionId: session.id, operationId: crypto.randomUUID() });
  const shutdownPeer = await connectPeer(`${pipe}-control`);
  try {
    const credential = (await readFile(join(scratch, 'data', 'runtime.credential'), 'utf8')).trim();
    await shutdownPeer.auth(credential);
    await shutdownPeer.request('runtime.shutdown', { operationId: crypto.randomUUID() });
    shutdownCompleted = true;
    report.checks.push('dedicated authenticated control peer acknowledged runtime shutdown after stopping the test PTYs');
  } finally {
    shutdownPeer.close();
  }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) await page.screenshot({ path: 'qa/results/floating-smoke-failure.png' }).catch(() => {});
  throw error;
} finally {
  report.completedAt = new Date().toISOString();
  await mkdir('qa/results', { recursive: true });
  await writeFile('qa/results/floating-smoke.json', JSON.stringify(report, null, 2));
  if (page && !shutdownCompleted) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await rm(scratch, { recursive: true, force: true });
}

