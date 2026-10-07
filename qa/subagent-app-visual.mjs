// Real Electron QA for native Codex subagent cards.  This uses only the
// deterministic fake app-server fixture; it never invokes a host provider.
// Run on virtual Desktop 1 (the desktop helper refuses to fall back to the
// user's desktop) and leaves OS notifications disabled.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';

const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const qa = dirname(fileURLToPath(import.meta.url));
const root = resolve(qa, '..');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
// desktop1.mjs reads this process environment before spawning Electron.
process.env.TT_QA_DESKTOP = '1';
const suppliedRuntime = option('--runtime') ?? process.env.THREADTERM_QA_RUNTIME_EXE;
const runtime = resolve(suppliedRuntime ?? join(root, 'runtime', 'target', 'debug', 'threadterm-v3-runtime.exe'));
assert.match(runtime.replace(/\\/gu, '/'), /runtime\/(?:target|target-qa)\/(?:debug\/)?threadterm-v3-runtime\.exe$/u, 'QA runtime required');
assert.ok(existsSync(runtime), `Missing QA runtime: ${runtime}`);

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-subagent-app-'));
const bin = join(scratch, 'bin');
const workspace = join(scratch, 'workspace');
const log = join(scratch, 'codex-subagent.jsonl');
const fixture = resolve(qa, 'fixtures', 'fake-codex-subagent.cjs');
const out = resolve(root, 'qa', 'results', 'subagent-app');
assert.ok(existsSync(fixture), `Missing fake Codex subagent fixture: ${fixture}`);

// Remove all PATH spellings before supplying the intentionally tiny shim path.
// This prevents either Electron or the runtime from locating a real Codex CLI.
const removed = new Set(['path', 'codex_home', 'openai_api_key', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime', 'threadterm_v3_dev_server_url', 'threadterm_qa_codex_subagent_release']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !removed.has(key.toLowerCase())));
Object.assign(env, {
  Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_DATA: join(scratch, 'data'),
  THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\threadterm-subagent-app-${randomUUID()}`,
  THREADTERM_V3_RUNTIME: runtime,
  CODEX_HOME: join(scratch, 'provider-home'),
  TT_QA_NODE: process.execPath,
  TT_QA_SCRIPT: fixture,
  THREADTERM_QA_CODEX_SUBAGENT_LOG: log,
  THREADTERM_QA_CODEX_SUBAGENT_CWD: workspace,
});
assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path'], 'every inherited PATH spelling was removed');
assert.deepEqual(env.Path.split(';'), [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')], 'runtime PATH contains only the fake-provider shim, Node, and System32');

let app;
let page;
let session;
let leaseEpoch;
const report = { passed: false, runtime, scratch, screenshots: [], checks: [] };
const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
async function until(check, label, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}
async function snapshot() { return rpc('runtime.snapshot'); }
async function transcript() { return rpc('chat.read', { sessionId: session.id }); }
async function sessionState() { return (await snapshot()).sessions.find(candidate => candidate.id === session.id); }
async function send(text) {
  return rpc('chat.send', { sessionId: session.id, text, leaseEpoch, operationId: randomUUID() });
}
function sessionChat() {
  return page.locator(`[data-testid="session-chat-${session.id}"]`);
}
async function openSession(mode) {
  const cwd = join(workspace, `scenario-${mode}`);
  session = await rpc('session.create', { cwd, provider: 'codex', mode: 'chat', title: `Subagent app QA · ${mode}`, operationId: randomUUID() });
  leaseEpoch = (await rpc('session.claim', { sessionId: session.id, clientId: 'subagent-app-visual' })).leaseEpoch;
  await rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await sessionChat().waitFor();
  await until(async () => (await rpc('chat.connection', { sessionId: session.id })).phase === 'ready', `chat connection ready (${mode})`);
}
async function shot(name) {
  const path = join(out, name);
  await page.screenshot({ path, animations: 'disabled' });
  report.screenshots.push(name);
}

try {
  await Promise.all([bin, workspace, ...['slow', 'normal', 'approval'].map(mode => join(workspace, `scenario-${mode}`)), env.THREADTERM_V3_DATA, env.THREADTERM_V3_USER_DATA, env.CODEX_HOME, out].map(path => mkdir(path, { recursive: true })));
  await writeFile(log, '');
  // The fixture is the only executable named codex on this PATH.  Use an exe
  // shim so Windows process lookup cannot select a host codex.cmd/bat.
  const shim = 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}';
  await writeFile(join(bin, 'shim.rs'), shim);
  const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'codex.exe')], { encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.ok(existsSync(join(bin, 'codex.exe')), 'fake Codex rustc shim exists');
  assert.equal(env.TT_QA_SCRIPT, fixture, 'the fake provider script is explicit');

  app = await electron.launch({ args: [root], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(30_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  const initial = await snapshot();
  await rpc('settings.update', {
    patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } },
    expectedRevision: initial.settings?.revision ?? 0,
    operationId: randomUUID(),
  });
  await rpc('project.add', { path: workspace, name: 'Subagent app QA', operationId: randomUUID() });

  // A slow child keeps the card visibly running until the parent Stop action.
  await openSession('slow');
  const slow = await send('slow');
  const slowCard = sessionChat().locator('.chat-subagent-card[data-subagent-key="qa-subagent-child"]');
  await slowCard.locator('.chat-subagent-status', { hasText: 'Running' }).waitFor();
  assert.equal((await sessionState()).status, 'running', 'slow fixture keeps the parent turn active');
  await shot('01-live-running.png');
  await rpc('chat.cancel', { sessionId: session.id, turnId: slow.turnId, leaseEpoch });
  await until(async () => (await sessionState())?.status === 'idle', 'cancelled slow parent settles');

  await openSession('normal');
  const normal = await send('normal');
  const card = sessionChat().locator('.chat-subagent-card[data-subagent-key="qa-subagent-child"]');
  await card.locator('.chat-subagent-status', { hasText: 'Completed' }).waitFor();
  await until(async () => (await sessionState())?.status === 'idle', 'normal parent completion');
  const completed = await transcript();
  const subagent = completed.flatMap(item => item.parts).find(part => part.type === 'subagent')?.data;
  assert.equal(subagent?.status, 'completed', 'normal fixture completes the child card');
  assert.equal(subagent?.toolCount, 1, 'completed child card exposes its command count');
  await shot('02-completed.png');

  await card.locator('summary').click();
  await card.locator('.chat-subagent-transcript').waitFor();
  await until(async () => (await card.locator('.chat-subagent-transcript').innerText()).includes('CHILD-ANSWER: three files'), 'expanded child transcript');
  await shot('03-expanded-transcript.png');

  await openSession('approval');
  const approval = await send('approval');
  let approvalPart;
  await until(async () => {
    approvalPart = (await transcript()).flatMap(item => item.parts)
      .find(part => part.type === 'approval' && part.status === 'pending');
    return typeof approvalPart?.data?.subagent?.label === 'string' && approvalPart.data.subagent.label.length > 0;
  }, 'child approval with subagent label');
  const label = approvalPart.data.subagent.label;
  const approvalCard = sessionChat().locator('.chat-approval-card').filter({ hasText: 'Subagent' }).filter({ hasText: label });
  await approvalCard.waitFor();
  assert.equal(await approvalCard.count(), 1, 'child approval card renders the runtime subagent label');
  await shot('04-child-approval.png');

  report.checks = [
    'Desktop 1 inactive Electron launch with native notifications disabled',
    'running child card captured before parent cancellation',
    'completed child card and tool count captured',
    'expanded live transcript captured',
    `child approval card exposes its native subagent label (${label})`,
  ];
  report.turns = { slow: slow.turnId, normal: normal.turnId, approval: approval.turnId };
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await rpc('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
