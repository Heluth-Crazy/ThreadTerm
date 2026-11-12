// Real Electron regression for Grok histories whose recorded folder differs
// from the directory a user selects. The fake is an isolated ACP provider.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';
import { buildQaApp } from './lib/qa-app.mjs';

const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const qaDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(qaDir, '..');
const runtime = process.env.THREADTERM_QA_RUNTIME_EXE ?? process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-grok-resume-'));
const bin = join(scratch, 'bin');
const projectA = join(scratch, 'project-a');
const projectB = join(scratch, 'project-b');
const data = join(scratch, 'data');
const profile = join(scratch, 'profile');
const events = join(scratch, 'provider-events.jsonl');
const pipe = `\\\\.\\pipe\\threadterm-grok-resume-${randomUUID()}`;
const out = join(root, 'qa/results/grok-terminal-resume');
const nativeId = '01a1c6f0-0000-7000-8000-000000000048';
const report = { passed: false, scratch, runtime, checks: [], screenshots: [] };
const { appDir, cleanup: cleanupApp } = await buildQaApp({ root });
let app;
let page;

const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(probe, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await probe(); if (value) return value; } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}
async function rows(path) {
  try { return (await readFile(path, 'utf8')).split(/\r?\n/u).filter(Boolean).map(JSON.parse); } catch { return []; }
}
async function capture(label, visible) {
  for (const theme of ['light', 'dark']) {
    const { settings } = await request('runtime.snapshot');
    await request('settings.update', { patch: { theme }, expectedRevision: settings.revision, operationId: randomUUID() });
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      if (visible) await visible.waitFor({ state: 'visible' });
      const name = `${label}-${theme}-${width}.png`;
      await page.screenshot({ path: join(out, name) });
      report.screenshots.push(name);
    }
  }
}
async function setDirectoryPicker(path) {
  await app.evaluate(({ ipcMain }, chosen) => {
    ipcMain.removeHandler('threadterm:choose-directory');
    ipcMain.handle('threadterm:choose-directory', () => chosen);
  }, path);
}
async function openHistory() {
  await page.locator('.nav-item').filter({ hasText: /^All terminals$/u }).click();
  await page.locator('.terminals-page').waitFor();
  await page.getByRole('button', { name: 'Local history', exact: true }).click();
  await page.locator('.local-history-dialog').waitFor();
  return page.locator('.history-rail-native');
}

const fakeGrok = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const id = '${nativeId}';
const recorded = ${JSON.stringify(projectA)};
const event = row => appendFileSync(process.env.TT_QA_GROK_EVENTS, JSON.stringify(row) + '\n');
if (process.argv.includes('--version')) { console.log('grok 1.0.75 fixture'); process.exit(0); }
if (!process.argv.includes('agent')) {
  event({ kind: 'terminal', argv: process.argv.slice(2), cwd: process.cwd() });
  setInterval(() => {}, 1000);
} else {
  const reply = (requestId, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, result }) + '\n');
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line); event({ kind: 'acp', method: request.method, params: request.params ?? null });
    if (request.method === 'initialize') return reply(request.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, load: {}, resume: {} } } });
    if (request.method === 'session/list') return reply(request.id, { data: [{ sessionId: id, cwd: recorded, title: 'Project A Grok history', updatedAt: '2026-11-12T00:00:00.000Z' }] });
    if (request.method === 'session/load') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Saved in project A.' } } } }) + '\n');
      return reply(request.id, { sessionId: id });
    }
    if (request.method === 'session/resume') return reply(request.id, { sessionId: id });
    if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unexpected ' + request.method } }) + '\n');
  });
}
`;

try {
  await Promise.all([bin, projectA, projectB, data, profile, out, join(scratch, 'temp')].map(path => mkdir(path, { recursive: true })));
  await Promise.all([writeFile(events, ''), writeFile(join(bin, 'fake-grok.mjs'), fakeGrok)]);
  await writeFile(join(bin, 'grok.cmd'), `@echo off\r\n${JSON.stringify(process.execPath)} ${JSON.stringify(join(bin, 'fake-grok.mjs'))} %*\r\n`);
  const excluded = new Set(['path', 'home', 'userprofile', 'appdata', 'localappdata', 'temp', 'tmp', 'threadterm_qa_provider_bin', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !excluded.has(name.toLowerCase())));
  Object.assign(env, {
    Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'local'), TEMP: join(scratch, 'temp'), TMP: join(scratch, 'temp'),
    THREADTERM_QA_PROVIDER_BIN: bin, THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: profile, THREADTERM_V3_PIPE: pipe, THREADTERM_V3_RUNTIME: runtime,
    TT_QA_GROK_EVENTS: events,
  });
  app = await electron.launch({ args: [appDir], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(20_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('#boot-splash').waitFor({ state: 'detached' });
  const { settings } = await request('runtime.snapshot');
  await request('settings.update', { patch: { language: 'en' }, expectedRevision: settings.revision, operationId: randomUUID() });
  const originalProject = await request('project.add', { path: projectA, name: 'Project A', operationId: randomUUID() });
  await request('project.add', { path: projectB, name: 'Project B', operationId: randomUUID() });
  await assert.rejects(request('history.import', {
    cwd: projectB, projectId: originalProject.id, provider: 'grok', mode: 'terminal', nativeId, operationId: randomUUID(),
  }), /Choose that directory and try again/i);

  const rail = await openHistory();
  const history = rail.locator('.history-native-list article').filter({ hasText: 'Project A Grok history' });
  await history.waitFor();
  await history.getByRole('button', { name: 'Read', exact: true }).click();
  await rail.locator('.history-detail').waitFor();
  await until(() => rail.locator('.history-detail-transcript').innerText().then(text => text.includes('Saved in project A.')), 'native history transcript');
  await setDirectoryPicker(projectB);
  await rail.getByRole('button', { name: 'Choose directory', exact: true }).click();
  await rail.getByRole('button', { name: 'Import card', exact: true }).click();
  const mismatch = rail.locator('.history-error');
  await mismatch.waitFor();
  const mismatchText = await mismatch.innerText();
  assert.match(mismatchText, /Choose that directory and try again/i, 'the visible error explains how to retry');
  assert.match(mismatchText, new RegExp(projectA.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'i'), 'the UI names Grok’s recorded directory');
  assert.equal((await request('runtime.snapshot')).sessions.some(session => session.nativeId === nativeId), false, 'a rejected first import creates no ThreadTerm card');
  assert.equal((await rows(events)).some(row => row.kind === 'terminal'), false, 'a rejected first import creates no PTY');
  await capture('cross-directory-refused', mismatch);
  report.checks.push('a Grok history chosen from project B is refused before a card or PTY and the visible error names project A');

  await setDirectoryPicker(projectA);
  await rail.getByRole('button', { name: 'Choose directory', exact: true }).click();
  await rail.getByRole('button', { name: 'Import card', exact: true }).click();
  await rail.getByText('Read-only history card saved.').waitFor();
  const imported = (await request('runtime.snapshot')).sessions.find(session => session.nativeId === nativeId);
  assert.ok(imported?.readOnly, 'the recorded directory imports as a read-only card');
  assert.equal(imported.projectId, originalProject.id);
  await assert.rejects(request('session.resume', {
    cwd: projectB, sessionId: imported.id, operationId: randomUUID(), resume: true,
  }), /Choose that directory and try again/i);
  assert.equal((await request('runtime.snapshot')).sessions.find(session => session.id === imported.id)?.readOnly, true);
  assert.equal((await rows(events)).some(row => row.kind === 'terminal'), false);
  await rail.getByRole('button', { name: 'Resume explicitly', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Resume native session' });
  await confirmation.waitFor();
  await confirmation.getByRole('button', { name: 'Resume', exact: true }).click();
  await until(() => request('runtime.snapshot').then(snapshot => snapshot.sessions.find(session => session.id === imported.id)?.status === 'running'), 'Grok terminal launch');
  const terminal = await until(() => rows(events).then(found => found.find(row => row.kind === 'terminal')), 'fake Grok terminal launch');
  assert.deepEqual(terminal.argv, ['--resume', nativeId], 'the terminal resumes the exact identity');
  assert.equal(terminal.cwd.toLowerCase(), projectA.toLowerCase(), 'the terminal runs in its recorded directory');
  await capture('recorded-directory-resumed');
  report.checks.push('the user can choose project A, preserve the native ID, and explicitly resume the terminal there');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await cleanupApp();
}
