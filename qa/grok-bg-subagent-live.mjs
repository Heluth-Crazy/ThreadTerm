// Windows-only live Grok background-subagent QA. Claude runs this on Desktop 1;
// implementation agents syntax-check it only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { electron } from './lib/desktop1.mjs';
import { buildQaApp } from './lib/qa-app.mjs';

assert.equal(process.platform, 'win32', 'Desktop-1 Grok QA requires Windows');
const root = resolve(import.meta.dirname, '..');
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE ?? process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
assert.ok(existsSync(runtime), `Missing runtime: ${runtime}`);
const { appDir, cleanup: cleanupApp } = await buildQaApp({ root });
process.env.TT_QA_DESKTOP = '1';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|grok_home)$/i.test(key) && !key.toLowerCase().startsWith('threadterm_')));
const sourcePath = process.env.Path ?? process.env.PATH ?? '';
const source = process.env.THREADTERM_QA_GROK ?? sourcePath.split(';').map(dir => join(dir, 'grok.exe')).find(existsSync);
assert.ok(source && existsSync(source), 'Grok executable was not found; set THREADTERM_QA_GROK to its full path');
const scratch = await mkdtemp(join(tmpdir(), 'tt-grok-bg-subagent-live-'));
const bin = join(scratch, 'bin'), work = join(scratch, 'workspace'), out = join(root, 'qa/results/grok-bg-subagent-live');
await Promise.all([bin, work, out].map(path => mkdir(path, { recursive: true })));
await writeFile(join(work, 'alpha.txt'), 'alpha\n');
await writeFile(join(work, 'beta.txt'), 'beta\n');
await writeFile(join(work, 'notes.md'), 'notes\n');
await writeFile(join(bin, 'grok.cmd'), `@echo off\r\n"${source}" %*\r\n`);
Object.assign(env, { Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-grok-bg-subagent-${randomUUID()}` });
assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path']);
let app, page, sessionId; const report = { passed: false, checks: [], screenshots: [], paneWidths: [] };
const delay = ms => new Promise(done => setTimeout(done, ms));
async function until(check, label, timeout = 180_000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; await delay(250); } throw Error(`Timed out: ${label}`); }
// The sidebar collapses below ~720 px, so a narrow pane needs a viewport under 720.
async function shot(name, target) {
  const chat = page.locator(`[data-testid="session-chat-${sessionId}"]`);
  const viewport = page.viewportSize()?.width ?? 1440;
  const initialPane = await chat.evaluate(node => node.getBoundingClientRect().width);
  let width = Math.max(360, Math.round(target + viewport - initialPane));
  await page.setViewportSize({ width, height: 900 });
  let paneWidth = await chat.evaluate(node => Math.round(node.getBoundingClientRect().width));
  if (Math.abs(paneWidth - target) > 8) {
    width = Math.max(360, width + target - paneWidth);
    await page.setViewportSize({ width, height: 900 });
    paneWidth = await chat.evaluate(node => Math.round(node.getBoundingClientRect().width));
  }
  assert.ok(Math.abs(paneWidth - target) <= 8, `${name}: pane ${paneWidth}px, expected ${target}px`);
  const fit = await chat.evaluate(node => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
  assert.ok(fit.scrollWidth <= fit.clientWidth + 1, `${name}: horizontal overflow`);
  await delay(150);
  await page.screenshot({ path: join(out, name), animations: 'disabled' });
  report.screenshots.push(name); report.paneWidths.push({ name, target, paneWidth, viewportWidth: width, ...fit });
}
try {
  app = await electron.launch({ args: [appDir], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 }); await page.waitForFunction(() => Boolean(window.threadterm));
  const rpc = (method, params = {}) => page.evaluate(([m, p]) => window.threadterm.request(m, p), [method, params]);
  const initial = await rpc('runtime.snapshot');
  await rpc('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });
  const project = await rpc('project.add', { path: work, name: 'Grok background subagent QA', operationId: randomUUID() });
  const created = await rpc('session.create', { projectId: project.id, cwd: work, title: 'Grok background subagent QA', provider: 'grok', mode: 'chat', operationId: randomUUID() });
  sessionId = created.id;
  const leaseEpoch = (await rpc('session.claim', { sessionId: created.id, clientId: 'grok-bg-subagent-live' })).leaseEpoch;
  await rpc('session.present', { sessionId: created.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await rpc('chat.connect', { sessionId: created.id, leaseEpoch, operationId: randomUUID() });
  await until(async () => (await rpc('chat.connection', { sessionId: created.id })).phase === 'ready', 'Grok chat ready');
  const turn = await rpc('chat.send', { sessionId: created.id, leaseEpoch, operationId: randomUUID(), text: 'Spawn exactly one background subagent with run_in_background=true to count the files in this folder. End your turn immediately. When it completes, state the exact count in a follow-up assistant message.' });
  const card = page.locator(`[data-testid="session-chat-${created.id}"] .chat-subagent-card`).first(); await card.waitFor({ timeout: 120_000 });
  await until(async () => (await card.getAttribute('class')).split(' ').includes('is-running'), 'running background subagent card');
  await shot('01-running-wide.png', 1000); await shot('02-running-narrow.png', 420);
  await until(async () => (await card.getAttribute('class')).split(' ').includes('is-completed'), 'completed background subagent card');
  await shot('03-completed-wide.png', 1000); await shot('04-completed-narrow.png', 420);
  const rows = await until(async () => { const items = await rpc('chat.read', { sessionId: created.id }); const snapshot = await rpc('runtime.snapshot'); const followUp = items.filter(item => item.role === 'assistant' && item.turnId && item.turnId !== turn.turnId).flatMap(item => item.parts).filter(part => part.type === 'text').map(part => part.text ?? '').join(''); const status = snapshot.sessions.find(item => item.id === created.id)?.status; return status === 'idle' && /three|3/i.test(followUp) ? { items, followUp } : undefined; }, 'completed agent-initiated follow-up');
  assert.match(rows.followUp, /three|3/i, `follow-up assistant text omitted the file count: ${rows.followUp}`);
  assert.ok(rows.items.some(item => item.role === 'assistant' && item.turnId && item.turnId !== turn.turnId), 'follow-up merged into the original turn');
  await until(async () => (await page.locator(`[data-testid="session-chat-${created.id}"] .v3-chat-message.assistant:not(.chat-subagent-card)`).allInnerTexts())
    .some(text => /(?:three|3)\s+files/i.test(text)), 'follow-up assistant text rendered outside the subagent card');
  await shot('05-follow-up-wide.png', 1000); await shot('06-follow-up-narrow.png', 420);
  report.checks.push('Desktop 1 Grok background card ran to completion and an agent-initiated follow-up rendered in its own assistant turn'); report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally { if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {}); if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); } await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); const sessionsRoot = resolve(homedir(), '.grok', 'sessions'); const grokSession = resolve(sessionsRoot, encodeURIComponent(work)); assert.ok(grokSession.startsWith(`${sessionsRoot}\\`)); await rm(grokSession, { recursive: true, force: true }).catch(() => {}); const tempRoot = resolve(tmpdir()); assert.ok(resolve(scratch).startsWith(`${tempRoot}\\`) && scratch.includes('tt-grok-bg-subagent-live-')); await rm(scratch, { recursive: true, force: true }); console.log(JSON.stringify(report)); await cleanupApp(); }
