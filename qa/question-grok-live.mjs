// Windows-only live Grok question-card QA. Claude runs this on Desktop 1;
// implementation agents must syntax-check it only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { electron } from './lib/desktop1.mjs';

assert.equal(process.platform, 'win32', 'Desktop-1 Grok QA requires Windows');
const root = resolve(import.meta.dirname, '..');
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE ?? join(root, 'runtime/target/debug/threadterm-v3-runtime.exe'));
assert.ok(existsSync(runtime), `Missing runtime: ${runtime}`);
process.env.TT_QA_DESKTOP = '1';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|threadterm_|grok_home)$/i.test(key)));
const source = process.env.THREADTERM_QA_GROK ?? process.env.PATH?.split(';').map(dir => join(dir, 'grok.exe')).find(existsSync);
assert.ok(source && existsSync(source), 'Grok executable was not found; set THREADTERM_QA_GROK to its full path');
const scratch = await mkdtemp(join(tmpdir(), 'tt-grok-question-live-'));
const bin = join(scratch, 'bin'), work = join(scratch, 'workspace'), out = join(root, 'qa/results/grok-question-live');
await Promise.all([bin, work, out].map(path => mkdir(path, { recursive: true })));
await writeFile(join(bin, 'grok.cmd'), `@echo off\r\n"${source}" %*\r\n`);
Object.assign(env, { Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-grok-question-${randomUUID()}` });
assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path']);
let app, page; const report = { passed: false, checks: [], screenshots: [] };
const delay = ms => new Promise(done => setTimeout(done, ms));
async function until(check, label, timeout = 120_000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; await delay(250); } throw Error(`Timed out: ${label}`); }
try {
  app = await electron.launch({ args: [root], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 }); await page.waitForFunction(() => Boolean(window.threadterm));
  const rpc = (method, params = {}) => page.evaluate(([m, p]) => window.threadterm.request(m, p), [method, params]);
  const initial = await rpc('runtime.snapshot');
  await rpc('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });
  const project = await rpc('project.add', { path: work, name: 'Grok question live', operationId: randomUUID() });
  const created = await rpc('session.create', { projectId: project.id, cwd: work, title: 'Grok question live', provider: 'grok', mode: 'chat', operationId: randomUUID() });
  const leaseEpoch = (await rpc('session.claim', { sessionId: created.id, clientId: 'grok-question-live' })).leaseEpoch;
  await rpc('session.present', { sessionId: created.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await rpc('chat.connect', { sessionId: created.id, leaseEpoch, operationId: randomUUID() });
  await until(async () => (await rpc('chat.connection', { sessionId: created.id })).phase === 'ready', 'Grok chat ready');
  const questionText = 'Which color should the QA use?';
  const turn = await rpc('chat.send', { sessionId: created.id, leaseEpoch, operationId: randomUUID(), text: `Use ask_user_question now. Ask exactly this question: "${questionText}". Offer exactly Blue and Red, wait for the user choice, then reply with the chosen label only.` });
  const card = page.locator('.chat-question-card'); await card.waitFor({ timeout: 120_000 });
  assert.match(await card.innerText(), new RegExp(questionText.replace(/[?]/g, '\\?')));
  await page.screenshot({ path: join(out, '01-pending.png') }); report.screenshots.push('01-pending.png');
  await card.getByText('Blue', { exact: true }).click(); await card.getByRole('button', { name: /submit/i }).click();
  const items = await until(async () => { const rows = await rpc('chat.read', { sessionId: created.id }); const snapshot = await rpc('runtime.snapshot'); const question = rows.flatMap(row => row.parts).find(part => part.type === 'approval' && part.data?.interaction === 'question'); const status = snapshot.sessions.find(row => row.id === created.id)?.status; return ['idle', 'awaiting_input'].includes(status) && question?.status === 'answered' ? rows : undefined; }, 'question answer and native turn completion');
  const answer = items.filter(row => row.turnId === turn.turnId && row.role === 'assistant' && row.parts.some(part => part.type === 'text' && part.text)).at(-1)?.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('') ?? '';
  assert.match(answer, /Blue/i, `final assistant reply omitted selected label: ${answer}`);
  await page.screenshot({ path: join(out, '02-answered.png') }); report.screenshots.push('02-answered.png');
  report.checks.push('Desktop 1 Grok card answered, native turn completed, and final assistant reply contained Blue'); report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally { if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {}); if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); } await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); const sessionsRoot = resolve(homedir(), '.grok', 'sessions'); const grokSession = resolve(sessionsRoot, encodeURIComponent(work)); assert.ok(grokSession.startsWith(`${sessionsRoot}\\`)); await rm(grokSession, { recursive: true, force: true }).catch(() => {}); const tempRoot = resolve(tmpdir()); assert.ok(resolve(scratch).startsWith(`${tempRoot}\\`) && scratch.includes('tt-grok-question-live-')); await rm(scratch, { recursive: true, force: true }); console.log(JSON.stringify(report)); }
