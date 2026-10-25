// Windows-only live Grok repair QA. Run manually on Desktop 1; implementation
// agents syntax-check this harness but never start a live provider session.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { electron } from './lib/desktop1.mjs';
import { buildQaApp } from './lib/qa-app.mjs';

assert.equal(process.platform, 'win32', 'Desktop-1 Grok QA requires Windows');
const root = resolve(import.meta.dirname, '..');
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE ?? process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime', 'target-qa', 'debug', 'threadterm-v3-runtime.exe'));
assert.ok(existsSync(runtime), `Missing QA runtime: ${runtime}`);
const { appDir, cleanup: cleanupApp } = await buildQaApp({ root });
process.env.TT_QA_DESKTOP = '1';

const sourcePath = process.env.Path ?? process.env.PATH ?? '';
const source = process.env.THREADTERM_QA_GROK ?? sourcePath.split(';').map(path => join(path, 'grok.exe')).find(existsSync);
assert.ok(source && existsSync(source), 'Grok executable was not found; set THREADTERM_QA_GROK to its full path');
const scratch = await mkdtemp(join(tmpdir(), 'tt-chat-repair-grok-live-'));
const bin = join(scratch, 'bin');
const work = join(scratch, 'workspace');
const out = join(root, 'qa', 'results', 'chat-repair-grok-live');
await Promise.all([bin, work, out].map(path => mkdir(path, { recursive: true })));
const methodLog = join(scratch, 'grok-methods.jsonl');
const launcherProxy = join(scratch, 'grok-launcher-proxy.mjs');
await writeFile(methodLog, '');
await writeFile(launcherProxy, `
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [source, log, ...args] = process.argv.slice(2);
const pending = new Map();
const record = (direction, method) => appendFileSync(log, JSON.stringify({ direction, method }) + '\\n');
const inspect = (direction, buffer) => {
  for (const line of buffer.lines.splice(0, buffer.lines.length)) {
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    if (direction === 'in' && frame?.method && frame.id !== undefined) pending.set(String(frame.id), frame.method);
    if (direction === 'out' && frame?.method) record('out', frame.method);
    if (direction === 'out' && !frame?.method && frame?.id !== undefined) {
      const request = pending.get(String(frame.id));
      if (request) { record('outReply', 'reply:' + request); pending.delete(String(frame.id)); }
    }
  }
};
const stream = (direction, target) => {
  let tail = '';
  const buffer = { lines: [] };
  return chunk => {
    target.write(chunk);
    tail += chunk.toString('utf8');
    const pieces = tail.split(/\\r?\\n/u); tail = pieces.pop() ?? '';
    buffer.lines.push(...pieces.filter(Boolean)); inspect(direction, buffer);
  };
};
const child = spawn(source, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
child.stdout.on('data', stream('in', process.stdout));
process.stdin.on('data', stream('out', child.stdin));
process.stdin.on('end', () => child.stdin.end());
child.on('error', error => { console.error(error.stack ?? String(error)); process.exitCode = 1; });
child.on('close', code => { process.stdout.end(() => process.exit(code ?? 1)); });
`, 'utf8');
await writeFile(join(bin, 'grok.cmd'), `@echo off\r\n"${process.execPath}" "${launcherProxy}" "${source}" "${methodLog}" %*\r\n`);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|grok_home|threadterm_)/i.test(key)));
Object.assign(env, {
  Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_RUNTIME: runtime,
  THREADTERM_V3_DATA: join(scratch, 'data'),
  THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-chat-repair-grok-live-${randomUUID()}`,
  THREADTERM_V3_RELOCATION_QA: '1',
  THREADTERM_QA_GROK_METHOD_LOG: methodLog,
});
assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path'], 'every inherited PATH spelling is removed');

const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
let app;
let page;
let session;
let leaseEpoch;
const report = { passed: false, runtime, screenshots: [], paneWidths: [], checks: [] };

const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const chat = () => page.locator(`[data-testid="session-chat-${session.id}"]`);
const lease = async () => (leaseEpoch = (await rpc('session.claim', { sessionId: session.id, clientId: 'chat-repair-grok-live' })).leaseEpoch);
async function leased(method, params) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await rpc(method, { ...params, leaseEpoch: await lease(), operationId: randomUUID() }); }
    catch (error) {
      if (attempt >= 5 || !/stale_lease/.test(String(error))) throw error;
      await delay(300);
    }
  }
}
async function until(check, label, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}
async function settings(language, theme) {
  const snapshot = await rpc('runtime.snapshot');
  await rpc('settings.update', {
    patch: { language, theme, notifications: { native: false, attention: false, completed: false, sound: false } },
    expectedRevision: snapshot.settings.revision,
    operationId: randomUUID(),
  });
}
async function setPane(target, label) {
  let width = Math.max(720, target + 520);
  await page.setViewportSize({ width, height: 900 });
  let pane = await chat().evaluate(node => Math.round(node.getBoundingClientRect().width));
  width = Math.max(720, width + target - pane);
  await page.setViewportSize({ width, height: 900 });
  pane = await chat().evaluate(node => Math.round(node.getBoundingClientRect().width));
  assert.ok(Math.abs(pane - target) <= 12, `${label}: pane ${pane}px is not about ${target}px`);
  const fit = await chat().evaluate(node => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
  assert.ok(fit.scrollWidth <= fit.clientWidth + 1, `${label}: horizontal overflow`);
  report.paneWidths.push({ label, pane, ...fit });
}
async function shot(stage, language, theme) {
  for (const [width, size] of [[1000, 'wide'], [420, 'narrow']]) {
    await setPane(width, `${stage}-${language}-${theme}-${size}`);
    const path = join(out, `${stage}-${language}-${theme}-${size}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    report.screenshots.push(path);
  }
}
async function matrix(stage) {
  for (const [language, theme] of [['en', 'light'], ['en', 'dark'], ['zh-CN', 'light'], ['zh-CN', 'dark']]) {
    await settings(language, theme);
    await shot(stage, language, theme);
  }
}
async function recordedMethods() {
  const lines = (await readFile(methodLog, 'utf8')).trim().split(/\r?\n/u).filter(Boolean);
  return lines.map(line => JSON.parse(line));
}
async function stage(name) {
  const [runtimeSnapshot, transcript, queue] = await Promise.all([
    rpc('runtime.snapshot'),
    rpc('chat.snapshot', { sessionId: session.id }),
    rpc('chat.queue.read', { sessionId: session.id }).catch(() => undefined),
  ]);
  const live = runtimeSnapshot.sessions.find(row => row.id === session.id);
  const entry = {
    name,
    at: new Date().toISOString(),
    sessionStatus: live?.status,
    activity: live?.activity ? { state: live.activity.state, revision: live.activity.revision, reason: live.activity.reason } : undefined,
    repair: transcript.repair ? {
      offered: transcript.repair.offered,
      degraded: transcript.repair.degraded,
      reason: transcript.repair.reason,
      ingressFailed: transcript.repair.ingressFailed,
    } : undefined,
    queue: queue ? { paused: queue.paused, pauseReason: queue.pauseReason, itemStates: queue.items.map(item => item.state) } : undefined,
  };
  report.stages = [...(report.stages ?? []), entry];
  process.stdout.write(`${JSON.stringify({ stage: entry })}\n`);
  return entry;
}
function normalizeHistory(items) {
  return items.map(({ id, createdAt, parts = [], ...item }) => ({
    ...item,
    id: String(id ?? '').replace(/^.*:history:/u, ''),
    parts: parts.map(({ status, ...part }) => ({
      ...part,
      ...(part.type === 'approval' && ['pending', 'submitting', 'expired'].includes(status)
        ? { status: 'expired-by-repair' }
        : status === undefined ? {} : { status }),
    })),
  }));
}
async function repairAction() {
  const action = page.getByRole('button', { name: /Repair from native history|从原生历史修复/ }).first();
  await action.click();
}

try {
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(30_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  await settings('en', 'light');

  const project = await rpc('project.add', { path: work, name: 'Live Grok repair QA', operationId: randomUUID() });
  session = await rpc('session.create', { projectId: project.id, cwd: work, title: 'Live Grok repair QA', provider: 'grok', mode: 'chat', operationId: randomUUID() });
  leaseEpoch = (await rpc('session.claim', { sessionId: session.id, clientId: 'chat-repair-grok-live' })).leaseEpoch;
  await rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await chat().waitFor();
  await rpc('chat.connect', { sessionId: session.id, leaseEpoch, operationId: randomUUID() });
  await until(async () => (await rpc('chat.connection', { sessionId: session.id })).phase === 'ready', 'Grok chat ready');
  const nativeId = await until(async () => (await rpc('runtime.snapshot')).sessions.find(row => row.id === session.id)?.nativeId, 'Grok native id');
  await stage('connected');

  await page.evaluate(async sessionId => {
    if (!window.threadtermQa?.failChatProjection) throw new Error('QA projection-failure bridge unavailable');
    await window.threadtermQa.failChatProjection(sessionId);
  }, session.id);
  await leased('chat.send', { sessionId: session.id, text: 'Reply with exactly: repair live QA ok.' });
  await until(async () => {
    const activity = (await rpc('runtime.snapshot')).sessions.find(row => row.id === session.id)?.activity?.state;
    return activity === 'running' ? activity : undefined;
  }, 'first Grok prompt active before queueing');
  await stage('first-prompt-active');
  await leased('chat.queue.add', { sessionId: session.id, text: 'This queued prompt must stay paused.' });
  await until(async () => (await rpc('chat.snapshot', { sessionId: session.id })).repair?.degraded === true, 'durable degraded repair descriptor');
  await until(async () => (await rpc('chat.queue.read', { sessionId: session.id })).paused === true, 'ingress fence pauses queued prompt');
  await stage('queue-paused-after-ingress-failure');

  const stop = chat().getByRole('button', { name: /Stop|停止/ });
  await until(async () => await stop.isVisible().catch(() => false)
    || (await rpc('chat.snapshot', { sessionId: session.id })).repair?.offered === true,
  'visible Stop or naturally settled turn');
  if (await stop.isVisible().catch(() => false)) {
    await stop.click();
    await stage('stop-requested');
  }
  await until(async () => (await rpc('chat.snapshot', { sessionId: session.id })).repair?.offered === true, 'repair eligible after Stop/settlement');
  await until(async () => ['awaiting_input', 'idle'].includes((await rpc('runtime.snapshot')).sessions.find(row => row.id === session.id)?.activity?.state), 'Grok turn settled before reading history');
  await stage('settled-before-history-read');
  const queueBeforeRepair = await rpc('chat.queue.read', { sessionId: session.id });
  const nativeHistory = await rpc('history.read', { provider: 'grok', nativeId });
  assert.ok(nativeHistory.length > 0, 'Grok history.read returned no transcript to compare');
  await stage('history-read-before-repair');

  await matrix('01-banner');
  await settings('en', 'light');
  await repairAction();
  await page.getByRole('dialog').waitFor();
  await matrix('02-confirm');
  await settings('en', 'light');
  const methodsBeforeRepair = await recordedMethods();
  await page.getByRole('dialog').getByRole('button', { name: /Repair history|修复历史/ }).click();
  const repaired = await until(async () => {
    const snapshot = await rpc('chat.snapshot', { sessionId: session.id });
    return snapshot.items?.length > 0
      && snapshot.items.every(item => String(item.id).includes(':history:'))
      && snapshot.repair?.degraded === false
      ? snapshot
      : undefined;
  }, 'non-empty scoped rebuilt transcript with cleared degradation');
  assert.deepEqual(normalizeHistory(repaired.items), normalizeHistory(nativeHistory), 'rebuilt items match history.read after scope and timestamp normalization');
  assert.equal(repaired.repair?.degraded, false, 'successful repair clears only the durable transcript marker');
  assert.equal(repaired.repair?.ingressFailed, true, 'repair does not clear the runtime ingress fence');
  assert.equal(repaired.items.flatMap(item => item.parts).filter(part => part.type === 'approval' && ['pending', 'submitting'].includes(part.status)).length, 0, 'repair leaves no actionable pending request');
  assert.equal((await rpc('runtime.snapshot')).inbox?.some(row => row.sessionId === session.id && !row.read), false, 'repair settles removed Inbox requests');
  const queueAfterRepair = await rpc('chat.queue.read', { sessionId: session.id });
  assert.deepEqual(queueAfterRepair.items, queueBeforeRepair.items, 'repair leaves queued rows byte-for-byte unchanged');
  assert.equal(queueAfterRepair.paused, queueBeforeRepair.paused, 'repair leaves queue pause state unchanged');
  assert.equal(queueAfterRepair.pauseReason, queueBeforeRepair.pauseReason, 'repair leaves settled pause reason unchanged');
  const resume = chat().getByRole('button', { name: /Resume queue|恢复队列/ });
  await resume.waitFor();
  assert.equal(await resume.isDisabled(), true, 'Resume queue stays disabled after a permanent ingress failure');
  const sendNow = chat().getByRole('button', { name: /Send queued prompt now|立即发送队列提示/ });
  await sendNow.waitFor();
  assert.equal(await sendNow.isDisabled(), true, 'Send now stays disabled after a permanent ingress failure');
  await page.locator('[role="status"]').filter({ hasText: /Queued prompts stay paused until ThreadTerm restarts|排队的提示词将保持暂停，直到 ThreadTerm 重启/ }).first().waitFor({ timeout: 10_000 });
  const allMethods = await recordedMethods();
  const repairMethods = allMethods.slice(methodsBeforeRepair.length);
  report.nativePromptCount = allMethods.filter(row => row.direction === 'out' && row.method === 'session/prompt').length;
  assert.equal(report.nativePromptCount, 1, 'only the explicit QA prompt was sent; queued prompt never dispatched');
  assert.equal(repairMethods.filter(row => row.direction === 'out' && row.method === 'session/load').length, 1, 'repair makes exactly one Grok session/load call');
  for (const method of ['session/new', 'session/prompt', 'session/cancel', 'reply:session/request_permission', 'reply:_x.ai/ask_user_question']) {
    assert.equal(repairMethods.some(row => row.method === method), false, `repair must not invoke ${method}`);
  }
  report.repairNativeMethods = repairMethods;
  await stage('repair-complete');
  await matrix('03-result');

  report.checks = [
    'Desktop 1, inactive launch, notifications disabled, Grok-only PATH shim',
    'QA hook degraded a live Grok chat; one explicit prompt was sent and a second prompt was queued',
    'Stop/settlement made repair eligible without a provider prompt during repair',
    'rebuilt transcript equals Grok history.read after id-scope and synthetic-timestamp normalization, including item grouping and full part properties',
    'repair made one session/load and no session/new, session/prompt, session/cancel, or permission reply',
    'pending requests and Inbox are settled; queue rows and pause state are unchanged; Resume and Send now are disabled while ingress remains failed',
    'banner, confirmation, and result captured at 1000px/420px for English/Chinese and light/dark',
  ];
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page && session) await stage('failure').catch(() => {});
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await rpc('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await mkdir(out, { recursive: true });
  const sessionsRoot = resolve(homedir(), '.grok', 'sessions');
  const grokSession = resolve(sessionsRoot, encodeURIComponent(work));
  assert.ok(grokSession.startsWith(`${sessionsRoot}\\`), 'refusing to remove a Grok session outside its session root');
  const tempRoot = resolve(tmpdir());
  assert.ok(resolve(scratch).startsWith(`${tempRoot}\\`) && scratch.includes('tt-chat-repair-grok-live-'), 'refusing to remove an unexpected temporary directory');
  try {
    await rm(grokSession, { recursive: true, force: true });
    assert.equal(existsSync(grokSession), false, 'throwaway Grok session was removed');
    await rm(scratch, { recursive: true, force: true });
    report.cleanupVerified = true;
  } catch (error) {
    report.passed = false;
    report.cleanupError = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
  }
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await cleanupApp();
}
