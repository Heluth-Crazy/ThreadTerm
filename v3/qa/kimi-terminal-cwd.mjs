// Native Kimi cwd regression. No prompts, approvals, credentials or user history.
// Uses its own KIMI_CODE_HOME and ThreadTerm data/pipe; never connects to the app.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { connectPeer } from './pipe-client.mjs';

if (process.platform !== 'win32') throw new Error('Windows native path regression');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-kimi-cwd-'));
const data = join(scratch, 'data');
const cwd = join(scratch, '工作目录 with spaces');
const providerHome = join(scratch, 'kimi-home');
await Promise.all([mkdir(data), mkdir(cwd), mkdir(providerHome)]);
await writeFile(join(providerHome, 'config.toml'), `default_model = "qa"
telemetry = false
auto_session_title = false
[providers.qa]
type = "openai"
base_url = "http://127.0.0.1:9/v1"
api_key = "qa-not-a-real-key"
[models.qa]
provider = "qa"
model = "qa"
max_context_size = 100000
capabilities = ["tool_use"]
`);
const pipe = `\\\\.\\pipe\\threadterm-kimi-cwd-${randomUUID()}`;
const env = { ...process.env, THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(scratch, 'user-data'), THREADTERM_V3_PIPE: pipe, KIMI_CODE_HOME: providerHome, KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_DISABLE_TELEMETRY: '1' };
const daemon = spawn(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target/debug/threadterm-v3-runtime.exe'), [], {
  windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  env,
});
let errors = ''; daemon.stderr.on('data', bytes => { errors += bytes.toString(); });
const delay = ms => new Promise(done => setTimeout(done, ms));
let peer;
const report = { scratch, providerHome, checks: [] };
async function loadFromCliCwd(nativeId) {
  const child = spawn('kimi', ['acp'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on('line', line => {
    let frame; try { frame = JSON.parse(line); } catch { return; }
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id); clearTimeout(entry.timer);
    if (frame.error) entry.reject(new Error(JSON.stringify(frame.error))); else entry.resolve(frame.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'threadterm-cwd-qa', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    await request('session/load', { sessionId: nativeId, cwd, mcpServers: [] });
  } finally { lines.close(); child.stdin.end(); child.kill(); }
}
async function output(id) {
  const value = await peer.request('terminal.read', { sessionId: id, cursor: 0, limit: 1048576 });
  return Buffer.from(value.data, 'base64').toString();
}
async function verify(id, label) {
  let text = '';
  let state;
  for (let i = 0; i < 100; i++) {
    text = await output(id);
    state = (await peer.request('runtime.snapshot')).sessions.find(session => session.id === id);
    if (/different directory|failed to start shell/i.test(text) || state.status !== 'running') break;
    if (text.length > 0 && i > 30) break;
    await delay(100);
  }
  await writeFile(join(scratch, `${label}.txt`), text);
  assert.doesNotMatch(text, /different directory|failed to start shell/i, `${label}: ${text.slice(-1800)}`);
  assert.equal(state.status, 'running', `${label}: native process exited: ${text.slice(-1800)}`);
  assert.ok(text.length > 0, 'native terminal must render output');
  if (/Trust this folder\?/i.test(text)) {
    report.checks.push(`${label}: TUI blocked by native trust prompt; not approved, not counted as editor-ready`);
  } else {
    report.checks.push(`${label}: native process live with no cwd mismatch (no prompt submitted)`);
  }
}
try {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      peer = await connectPeer(`${pipe}-control`);
      await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      break;
    } catch {
      peer?.close(); peer = undefined;
      if (daemon.exitCode !== null) throw new Error(errors);
      await delay(100);
    }
  }
  assert.ok(peer, 'isolated runtime connected');
  for (const [label, directory] of [['normal', cwd], ['verbatim', toNamespacedPath(cwd)]]) {
    const session = await peer.request('session.create', { cwd: directory, provider: 'kimi', mode: 'terminal', operationId: randomUUID() }, 90000);
    assert.ok(session.nativeId);
    const listed = spawnSync('kimi', ['session', 'list', '--cwd', cwd, '--json'], { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(JSON.parse(listed.stdout).some(item => item.id === session.nativeId), `${label}: new session was stored under a different native cwd bucket than the CLI uses`);
    report.checks.push(`${label}: native CLI cwd-filtered list contains the exact allocated ID`);
    await loadFromCliCwd(session.nativeId);
    report.checks.push(`${label}: exact native ID loads using the CLI's ordinary cwd spelling`);
    await verify(session.id, `${label}-create`);
    await peer.request('session.stop', { sessionId: session.id, force: true, operationId: randomUUID() });
    const resumed = await peer.request('session.resume', { sessionId: session.id, operationId: randomUUID() }, 90000);
    assert.equal(resumed.nativeId, session.nativeId);
    assert.equal(resumed.id, session.id);
    await verify(session.id, `${label}-resume`);
    await peer.request('session.stop', { sessionId: session.id, force: true, operationId: randomUUID() });
  }
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = String(error); throw error;
} finally {
  await writeFile(join(scratch, 'report.json'), JSON.stringify(report, null, 2));
  await peer?.request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  peer?.close();
  if (daemon.exitCode === null) daemon.kill();
  console.log(JSON.stringify(report, null, 2));
}
