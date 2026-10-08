// Desktop-1 real-app QA for native-history repair. It is intentionally fake
// Codex only: PATH has one shim and the fixture never starts a real agent.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';

const delay = ms => new Promise(done => setTimeout(done, ms));
const qa = dirname(fileURLToPath(import.meta.url));
const root = resolve(qa, '..');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
process.env.TT_QA_DESKTOP = '1';
const runtime = resolve(option('--runtime') ?? process.env.THREADTERM_QA_RUNTIME_EXE ?? join(root, 'runtime', 'target', 'debug', 'threadterm-v3-runtime.exe'));
assert.ok(existsSync(runtime), `Missing QA runtime: ${runtime}`);
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-chat-repair-'));
const bin = join(scratch, 'bin'); const workspace = join(scratch, 'workspace');
const fixture = resolve(qa, 'fixtures', 'fake-codex-repair.cjs');
const log = join(scratch, 'fake-codex-repair.jsonl'); const out = join(root, 'qa', 'results', 'chat-repair');
const blocked = new Set(['path', 'codex_home', 'openai_api_key', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime', 'threadterm_v3_dev_server_url']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.has(key.toLowerCase())));
Object.assign(env, { Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\threadterm-chat-repair-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_RELOCATION_QA: '1', CODEX_HOME: join(scratch, 'provider-home'), TT_QA_NODE: process.execPath, TT_QA_SCRIPT: fixture, THREADTERM_QA_CODEX_REPAIR_LOG: log, THREADTERM_QA_CODEX_REPAIR_CWD: workspace });
assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path'], 'every inherited PATH spelling is removed');
assert.deepEqual(env.Path.split(';'), [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')], 'only fake shim, Node and System32 remain on PATH');

let app; let page; let project; let session; let leaseEpoch;
const report = { passed: false, runtime, scratch, screenshots: [], paneWidths: [], checks: [] };
const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
// The renderer shares this connection principal and may re-claim (new epoch) after a resync.
const lease = async () => (leaseEpoch = (await rpc('session.claim', { sessionId: session.id, clientId: 'chat-repair-visual' })).leaseEpoch);
// Retry with a fresh lease when the renderer's lease pool released/re-claimed (stale_lease); a stale_lease rejection never dispatches, so each attempt gets a fresh operationId.
const leased = async (method, params) => { for (let attempt = 0; ; attempt++) { try { const result = await rpc(method, { ...params, leaseEpoch: await lease(), operationId: randomUUID() }); report.leaseRetries = [...(report.leaseRetries ?? []), [method, attempt]]; return result; } catch (error) { if (attempt >= 5 || !/stale_lease/.test(String(error))) throw error; await delay(300); } } };
const chat = () => page.locator(`[data-testid="session-chat-${session.id}"]`);
async function until(check, label, timeout = 45_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await delay(100); } throw new Error(`Timed out: ${label}`); }
async function setPane(target, label) { let width = Math.max(720, target + 520); await page.setViewportSize({ width, height: 900 }); let pane = await chat().evaluate(node => Math.round(node.getBoundingClientRect().width)); width = Math.max(720, width + target - pane); await page.setViewportSize({ width, height: 900 }); pane = await chat().evaluate(node => Math.round(node.getBoundingClientRect().width)); assert.ok(Math.abs(pane - target) <= 12, `${label}: pane ${pane}px is not about ${target}px`); const fit = await chat().evaluate(node => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth })); assert.ok(fit.scrollWidth <= fit.clientWidth + 1, `${label}: horizontal overflow`); report.paneWidths.push({ label, pane, ...fit }); }
async function shot(name, language, theme) { for (const [width, size] of [[1000, 'wide'], [420, 'narrow']]) { await setPane(width, `${name}-${size}`); const path = join(out, `${name}-${language}-${theme}-${size}.png`); await page.screenshot({ path, animations: 'disabled' }); report.screenshots.push(path); } }
async function settings(language, theme) { const snapshot = await rpc('runtime.snapshot'); await rpc('settings.update', { patch: { language, theme, notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() }); }
async function repairAction() { const action = page.getByRole('button', { name: /Repair from native history|从原生历史修复/ }); await action.first().click(); }
async function matrix(name) { for (const [language, theme] of [['en', 'light'], ['en', 'dark'], ['zh-CN', 'light'], ['zh-CN', 'dark']]) { await settings(language, theme); await shot(name, language, theme); } }

try {
  await Promise.all([bin, workspace, env.THREADTERM_V3_DATA, env.THREADTERM_V3_USER_DATA, env.CODEX_HOME, out].map(path => mkdir(path, { recursive: true }))); await writeFile(log, '');
  await writeFile(join(bin, 'shim.rs'), 'fn main(){let s=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(s.code().unwrap_or(1));}');
  const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'codex.exe')], { encoding: 'utf8', windowsHide: true }); assert.equal(compiled.status, 0, compiled.stderr);
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', root], cwd: bin, env, timeout: 60_000 }); page = await app.firstWindow({ timeout: 30_000 }); page.setDefaultTimeout(30_000); await page.waitForFunction(() => Boolean(window.threadterm));
  await settings('en', 'light'); project = await rpc('project.add', { path: workspace, name: 'Chat repair QA', operationId: randomUUID() });
  session = await rpc('session.create', { projectId: project.id, cwd: workspace, provider: 'codex', mode: 'chat', title: 'Chat repair QA', operationId: randomUUID() }); leaseEpoch = (await rpc('session.claim', { sessionId: session.id, clientId: 'chat-repair-visual' })).leaseEpoch; await rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() }); await chat().waitFor(); await until(async () => (await rpc('chat.connection', { sessionId: session.id })).phase === 'ready', 'fake Codex ready');
  await page.evaluate(async sessionId => { if (!window.threadtermQa?.failChatProjection) throw new Error('QA projection-failure bridge unavailable'); await window.threadtermQa.failChatProjection(sessionId); }, session.id);
  await leased('chat.send', { sessionId: session.id, text: 'cause one lost projection', operationId: randomUUID() });
  await until(async () => (await rpc('chat.read', { sessionId: session.id })).some(item => item.parts.some(part => part.type === 'approval' && part.status === 'pending')), 'pending request before repair');
  await leased('chat.queue.add', { sessionId: session.id, text: 'must remain paused', operationId: randomUUID() });
  await until(async () => (await rpc('chat.snapshot', { sessionId: session.id })).repair?.degraded === true, 'durable degraded repair descriptor');
  const pausedQueue = await rpc('chat.queue.read', { sessionId: session.id });
  assert.equal(pausedQueue.paused, true, 'projection failure pauses the queue before Stop');
  await chat().getByRole('button', { name: /Stop|停止/ }).click();
  await until(async () => (await rpc('chat.snapshot', { sessionId: session.id })).repair?.offered === true, 'repair becomes eligible after Stop');
  const beforeRepairQueue = await rpc('chat.queue.read', { sessionId: session.id });
  await matrix('01-banner'); await settings('en', 'light');
  await repairAction(); await page.getByRole('dialog').waitFor(); await matrix('02-confirm'); await settings('en', 'light');
  const beforeRepairCalls = (await readFile(log, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse).filter(row => row.direction === 'in').map(row => row.method);
  await page.getByRole('dialog').getByRole('button', { name: /Repair history|修复历史/ }).click();
  await until(async () => { const { items } = await rpc('chat.snapshot', { sessionId: session.id }); return items.length > 0 && items.every(item => item.id.includes(':history:')); }, 'rebuilt history ids (non-empty)');
  const snapshot = await rpc('chat.snapshot', { sessionId: session.id }); assert.deepEqual(snapshot.items.map(item => [item.id, item.parts[0]?.text ?? item.parts[0]?.toolName]), [[`${session.id}:history:qa-repair-native-user`, 'native user'], [`${session.id}:history:qa-repair-native-tool`, 'commandExecution'], [`${session.id}:history:qa-repair-native-assistant`, 'native final answer']], 'rebuilt transcript equals fake thread/read native order');
  assert.equal(snapshot.items.flatMap(item => item.parts).filter(part => part.type === 'approval' && ['pending', 'submitting'].includes(part.status)).length, 0, 'no actionable request survives rebuild');
  assert.equal((await rpc('runtime.snapshot')).inbox?.some(row => row.sessionId === session.id && !row.read), false, 'repair settles the removed request in Inbox');
  const queue = await rpc('chat.queue.read', { sessionId: session.id }); assert.deepEqual(queue.items, beforeRepairQueue.items, 'repair leaves the queued prompt byte-for-byte unchanged'); assert.equal(queue.paused, beforeRepairQueue.paused, 'repair does not change queue pause state'); assert.equal(queue.pauseReason, beforeRepairQueue.pauseReason, 'repair does not change the settled pause reason');
  await page.locator('[role="status"]').filter({ hasText: /History rebuilt from the agent's record: 3 messages\./ }).first().waitFor({ timeout: 10_000 }); /* rebuild toast uses total count */ await shot('03-result', 'en', 'light'); await matrix('03-result');
  const calls = (await readFile(log, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse).filter(row => row.direction === 'in').map(row => row.method); const repairCalls = calls.slice(beforeRepairCalls.length); assert.equal(repairCalls.filter(method => method === 'thread/read').length, 1, 'repair made exactly one native history read'); assert.equal(repairCalls.filter(method => ['thread/start', 'thread/resume', 'turn/start'].includes(method)).length, 0, 'repair did not open/resume/send a provider turn');
  report.checks = ['Desktop 1, inactive launch, notifications disabled', 'case-insensitive PATH isolation and fake Codex only', 'QA hook fails one projection; degraded marker/banner persists; Stop settles eligibility', 'pending request is non-actionable and ingress-fenced queued prompt stays paused', 'repair transcript exactly equals fake thread/read in native order', 'banner, confirmation and result captured at 1000px/420px for English/Chinese and light/dark']; report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {}); process.exitCode = 1; }
finally { if (page) await rpc('runtime.shutdown', { operationId: randomUUID() }).catch(() => {}); if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); } await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); }
