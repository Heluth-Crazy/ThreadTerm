// Real Electron reconnect convergence QA. It uses only fake-codex-reconnect.cjs.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';
import { connectSubagentPeer } from './lib/subagent-peer.mjs';

const delay = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
const qa = dirname(fileURLToPath(import.meta.url));
const root = resolve(qa, '..');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
process.env.TT_QA_DESKTOP = '1';
const runtime = resolve(option('--runtime') ?? process.env.THREADTERM_QA_RUNTIME_EXE ?? join(root, 'runtime', 'target', 'debug', 'threadterm-v3-runtime.exe'));
assert.ok(existsSync(runtime), `Missing QA runtime: ${runtime}`);

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-chat-reconnect-'));
const bin = join(scratch, 'bin');
const workspace = join(scratch, 'workspace');
const control = join(scratch, 'control');
const fixture = resolve(qa, 'fixtures', 'fake-codex-reconnect.cjs');
const log = join(scratch, 'fake-codex.jsonl');
const out = resolve(root, 'qa', 'results', 'chat-reconnect');
assert.ok(existsSync(fixture), `Missing reconnect fixture: ${fixture}`);

// Remove every case spelling of PATH before installing the fake executable.
const blocked = new Set(['path', 'codex_home', 'openai_api_key', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime', 'threadterm_v3_dev_server_url']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.has(key.toLowerCase())));
Object.assign(env, {
  Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_DATA: join(scratch, 'data'),
  THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\threadterm-chat-reconnect-${randomUUID()}`,
  THREADTERM_V3_RUNTIME: runtime,
  THREADTERM_V3_RELOCATION_QA: '1',
  CODEX_HOME: join(scratch, 'codex-home'),
  TT_QA_NODE: process.execPath,
  TT_QA_SCRIPT: fixture,
  THREADTERM_QA_CODEX_RECONNECT_LOG: log,
  THREADTERM_QA_CODEX_RECONNECT_CWD: workspace,
  THREADTERM_QA_CODEX_RECONNECT_CONTROL: control,
});
assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path'], 'all inherited PATH spellings were removed');
assert.deepEqual(env.Path.split(';'), [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')], 'only shim, Node and System32 are on PATH');

let app;
let page;
let session;
let leaseEpoch;
const report = { passed: false, runtime, scratch, screenshots: [], checks: [] };
const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const chat = () => page.locator(`[data-testid="session-chat-${session.id}"]`);
async function until(check, label, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function shot(name, width) {
  await page.setViewportSize({ width, height: 900 });
  const path = join(out, name);
  await page.screenshot({ path, animations: 'disabled' });
  report.screenshots.push(path);
}
async function pasteImage() {
  await page.evaluate(() => new Promise(resolvePromise => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 10;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas unavailable');
    context.fillStyle = '#e53935'; context.fillRect(0, 0, 8, 10); context.fillStyle = '#1e88e5'; context.fillRect(8, 0, 8, 10);
    canvas.toBlob(blob => {
      if (!blob) throw new Error('PNG unavailable');
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'reconnect.png', { type: 'image/png' }));
      const input = document.querySelector('.chat-compose-shell textarea');
      if (!(input instanceof HTMLTextAreaElement)) throw new Error('Composer unavailable');
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }));
      resolvePromise(undefined);
    }, 'image/png');
  }));
  await chat().locator('.chat-image-draft img').waitFor();
}
async function renderedItems() {
  return page.evaluate((sessionId) => {
    const node = document.querySelector(`[data-testid="session-chat-${sessionId}"]`);
    if (!node) throw new Error('Chat root unavailable');
    const fiberKey = Object.keys(node).find(key => key.startsWith('__reactFiber$'));
    let fiber = fiberKey ? node[fiberKey] : undefined;
    // Vite minifies component names. Identify the nearest session component
    // structurally, then select its committed fiber rather than an old alternate.
    while (fiber && !(typeof fiber.type === 'function' && fiber.memoizedProps?.session?.id === sessionId && fiber.memoizedState)) fiber = fiber.return;
    if (!fiber) throw new Error('ChatView React fiber unavailable');
    let rootFiber = fiber;
    while (rootFiber.return) rootFiber = rootFiber.return;
    if (rootFiber.stateNode?.current !== rootFiber && fiber.alternate) fiber = fiber.alternate;
    for (let hook = fiber.memoizedState; hook; hook = hook.next) {
      const value = hook.memoizedState;
      if (Array.isArray(value) && value.every(item => item && typeof item.id === 'string' && Array.isArray(item.parts))) return value;
    }
    throw new Error('ChatView item state unavailable');
  }, session.id);
}

try {
  await Promise.all([bin, workspace, control, env.THREADTERM_V3_DATA, env.THREADTERM_V3_USER_DATA, env.CODEX_HOME, out].map(path => mkdir(path, { recursive: true })));
  await writeFile(log, '');
  const shim = 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}';
  await writeFile(join(bin, 'shim.rs'), shim);
  const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'codex.exe')], { encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stderr);

  app = await electron.launch({ args: [root], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(30_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  const initial = await rpc('runtime.snapshot');
  await rpc('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: initial.settings.revision, operationId: randomUUID() });
  const project = await rpc('project.add', { path: workspace, name: 'Reconnect QA', operationId: randomUUID() });
  session = await rpc('session.create', { projectId: project.id, cwd: workspace, provider: 'codex', mode: 'chat', title: 'Reconnect convergence QA', operationId: randomUUID() });
  leaseEpoch = (await rpc('session.claim', { sessionId: session.id, clientId: 'chat-reconnect-visual' })).leaseEpoch;
  await rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await chat().waitFor();
  await until(async () => (await rpc('chat.connection', { sessionId: session.id })).phase === 'ready', 'Codex connection');

  await rpc('chat.send', { sessionId: session.id, text: 'exercise reconnect convergence', leaseEpoch, operationId: randomUUID() });
  await until(async () => (await rpc('chat.read', { sessionId: session.id })).some(item => item.parts.some(part => part.text === 'BEFORE-CONTROL-DROP')), 'pre-gap text');
  await chat().locator('.chat-approval-card').waitFor();
  await until(async () => (await page.locator(`.project-catalog .sess-row-wrap[data-session-id="${session.id}"]`).getAttribute('data-activity')) === 'awaiting_approval', 'sidebar waiting state before gap');
  const dropped = await page.evaluate(async () => {
    if (!window.threadtermQa) throw new Error('QA control-drop bridge unavailable');
    await window.threadtermQa.dropControl(); return true;
  });
  assert.equal(dropped, true, 'QA-only bridge closed the Desktop control socket');
  await writeFile(join(control, 'release'), 'release\n');
  await until(async () => {
    const frames = await readFile(log, 'utf8');
    return frames.includes('"method":"serverRequest/resolved"') && frames.includes('"method":"thread/settings/updated"') && frames.includes('"method":"turn/completed"');
  }, 'fixture completed tool, approval and model update while control reconnect is paused');
  // A separate read-only authenticated peer proves DB projection completed in
  // the gap; merely observing stdout does not prove the desktop missed events.
  const observer = await connectSubagentPeer(`${env.THREADTERM_V3_PIPE}-control`);
  try {
    await observer.auth((await readFile(join(env.THREADTERM_V3_DATA, 'runtime.credential'), 'utf8')).trim());
    await until(async () => (await observer.request('runtime.snapshot')).sessions.find(row => row.id === session.id)?.status === 'idle', 'gap completion persisted before desktop resume');
    const gapSnapshot = await observer.request('chat.snapshot', { sessionId: session.id });
    assert.ok(gapSnapshot.items.some(item => item.parts.some(part => part.text === 'GAP-FINAL-ANSWER')), 'gap answer persisted while desktop was disconnected');
    assert.equal(gapSnapshot.items.flatMap(item => item.parts).filter(part => part.type === 'approval' && part.status === 'pending').length, 0, 'gap approval resolution persisted');
    report.gapRevision = gapSnapshot.revision;
  } finally { observer.close(); }
  await page.evaluate(async () => { await window.threadtermQa.resumeControl(); });

  await until(async () => (await rpc('runtime.snapshot')).sessions.find(row => row.id === session.id)?.status === 'idle', 'App refresh updated sidebar session state after reconnect');
  const snapshot = await rpc('chat.snapshot', { sessionId: session.id });
  await until(async () => JSON.stringify(await renderedItems()) === JSON.stringify(snapshot.items), 'mounted transcript converged to gap snapshot');
  const rendered = await renderedItems();
  assert.deepEqual(rendered, snapshot.items, 'mounted ChatView item state exactly equals chat.snapshot after resync');
  const ids = rendered.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'mounted ChatView has no duplicate item ids');
  assert.ok(rendered.some(item => item.parts.some(part => part.text === 'GAP-FINAL-ANSWER')), 'gap final answer converged into mounted ChatView');
  assert.ok(rendered.some(item => item.parts.some(part => part.type === 'tool')), 'gap tool converged into mounted ChatView');
  assert.equal(rendered.flatMap(item => item.parts).filter(part => part.type === 'approval' && part.status === 'pending').length, 0, 'mounted ChatView has no stale pending approval');
  await until(async () => (await chat().locator('.chat-model-name').innerText()).includes('QA reconnect B'), 'composer model after gap');
  // A completed turn with a reply is "awaiting_input" (reply ready) by design; the row must match the runtime's
  // current activity and must no longer show the gap's resolved approval.
  report.snapshotActivity = (await rpc('runtime.snapshot')).sessions.find(row => row.id === session.id)?.activity;
  assert.notEqual(report.snapshotActivity?.state, 'awaiting_approval', 'runtime activity left awaiting_approval');
  await until(async () => (await page.locator(`.project-catalog .sess-row-wrap[data-session-id="${session.id}"]`).getAttribute('data-activity')) === report.snapshotActivity?.state, 'actual sidebar row refreshed to the runtime activity');
  assert.equal(await chat().locator('.chat-approval-card button:not([disabled])').count(), 0, 'no actionable approval buttons remain');
  await shot('01-reconnected-wide.png', 1440);

  // Select a model through the actual composer, then prove the normalized image capability still accepts paste.
  await chat().locator('.chat-model-chip').click();
  await page.getByRole('menuitemradio', { name: 'QA reconnect A' }).click();
  await until(async () => (await chat().locator('.chat-model-name').innerText()).includes('QA reconnect A'), 'composer model change');
  await pasteImage();
  assert.equal(await chat().locator('.chat-image-draft img').count(), 1, 'image paste remains accepted after composer model change');
  // 720px window leaves an approximately 420px workspace pane beside the catalog.
  await shot('02-image-after-model-narrow.png', 720);

  report.checks = [
    'Desktop 1 inactive real-app launch; native notifications disabled',
    'control pipe cut only through the non-packaged QA gate',
    'pre-gap approval was visible, then gap text/tool/resolution/model update converged through chat.snapshot',
    'mounted ChatView item state has no duplicate ids or actionable stale approval buttons',
    'composer model and actual sidebar row updated after reconnect',
    'image paste accepted after composer model change',
  ];
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await rpc('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
