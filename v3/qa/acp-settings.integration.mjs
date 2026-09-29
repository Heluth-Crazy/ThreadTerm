// Isolated real-runtime ACP settings regression. Both provider executables are
// fake JSONL agents; no account, model prompt, or existing runtime is touched.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { connectPeer } from './pipe-client.mjs';

const delay = ms => new Promise(done => setTimeout(done, ms));
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-acp-settings-'));
const bin = join(scratch, 'bin');
const data = join(scratch, 'data');
const workspace = join(scratch, 'workspace');
const log = join(scratch, 'native-frames.jsonl');
const pipe = `\\\\.\\pipe\\threadterm-acp-settings-${randomUUID()}`;
await Promise.all([mkdir(bin), mkdir(data), mkdir(workspace), mkdir(join(scratch, 'kimi-home'))]);
const fixture = resolve('qa/fixtures/fake-acp-settings.cjs');
const shim = join(bin, 'shim.rs');
await writeFile(shim, 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}');
for (const provider of ['kimi', 'gemini']) {
  const output = spawnSync('rustc', [shim, '-o', join(bin, `${provider}.exe`)], { encoding: 'utf8', windowsHide: true });
  assert.equal(output.status, 0, output.stderr);
}
const runtime = process.env.THREADTERM_QA_RUNTIME_EXE || process.env.THREADTERM_V3_RUNTIME_BIN || (existsSync(resolve('runtime/target/debug/threadterm-v3-runtime.exe')) ? resolve('runtime/target/debug/threadterm-v3-runtime.exe') : resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const env = {
  ...process.env,
  Path: [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_DATA: data,
  THREADTERM_V3_PIPE: pipe,
  THREADTERM_QA_ACP_SETTINGS_LOG: log,
  KIMI_CODE_HOME: join(scratch, 'kimi-home'),
  TT_QA_NODE: process.execPath,
  TT_QA_SCRIPT: fixture,
};
delete env.THREADTERM_QA_ACP_VERSION_FAIL;
const daemon = spawn(runtime, [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
daemon.stderr.on('data', bytes => { stderr += bytes.toString(); });
let peer;
const checks = [];
const frames = async () => {
  try { return (await readFile(log, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); }
  catch { return []; }
};
const setting = (ui, name) => ui.options.find(option => option.id === name)?.value;
const set = (sessionId, leaseEpoch, optionId, value) => peer.request('chat.option.set', { sessionId, leaseEpoch, optionId, value, operationId: randomUUID() });

try {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      peer = await connectPeer(`${pipe}-control`);
      await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      break;
    } catch {
      peer?.close(); peer = undefined;
      if (daemon.exitCode !== null) throw new Error(stderr);
      await delay(50);
    }
  }
  assert.ok(peer, 'isolated runtime authenticated');
  const capabilities = await peer.request('provider.list');
  for (const provider of ['kimi', 'gemini']) {
    assert.equal(capabilities.find(item => item.id === provider)?.chat, true, `${provider} fake ACP capability`);
    const session = await peer.request('session.create', { cwd: workspace, provider, mode: 'chat', title: `${provider} settings QA`, operationId: randomUUID() });
    const { leaseEpoch } = await peer.request('session.claim', { sessionId: session.id, clientId: `qa-${provider}` });
    assert.equal((await peer.request('chat.connect', { sessionId: session.id, leaseEpoch, operationId: randomUUID() })).phase, 'ready');
    let ui = await peer.request('chat.options', { sessionId: session.id });
    assert.equal(setting(ui, 'model'), 'old-model');
    assert.equal(setting(ui, 'thinking'), 'low');
    const before = (await frames()).length;
    await assert.rejects(set(session.id, leaseEpoch, 'thinking', 'high'), /thinking rejected by QA agent/);
    ui = await peer.request('chat.options', { sessionId: session.id });
    assert.equal(setting(ui, 'thinking'), 'low');
    assert.equal((await frames()).slice(before).some(row => row.method === 'session/set_model'), false);
    checks.push(`${provider}: rejected thinking retains old value, no set_model`);

    ui = await set(session.id, leaseEpoch, 'model', 'new-model');
    assert.equal(setting(ui, 'model'), 'NEW-MODEL');
    for (const value of ['bad-model', 'auth-error']) {
      const start = (await frames()).length;
      await assert.rejects(set(session.id, leaseEpoch, 'model', value));
      assert.equal(setting(await peer.request('chat.options', { sessionId: session.id }), 'model'), 'NEW-MODEL');
      assert.equal((await frames()).slice(start).some(row => row.method === 'session/set_model'), false);
    }
    checks.push(`${provider}: canonical model value; invalid/auth errors do not fallback`);

    ui = await set(session.id, leaseEpoch, 'thinking', 'late-response');
    assert.equal(setting(ui, 'thinking'), 'ultra');
    assert.equal(setting(await peer.request('chat.options', { sessionId: session.id }), 'thinking'), 'ultra');
    assert.equal(setting(ui, 'model'), 'NEW-MODEL');
    checks.push(`${provider}: newer config notification survives stale RPC response`);

    const start = (await frames()).length;
    ui = await set(session.id, leaseEpoch, 'model', 'legacy-model');
    assert.equal(setting(ui, 'model'), 'legacy-model');
    assert.equal((await frames()).slice(start).filter(row => row.method === 'session/set_model').length, 1);
    checks.push(`${provider}: structured method-not-found alone uses legacy model RPC`);

    if (provider === 'kimi') {
      const timeoutStart = (await frames()).length;
      await assert.rejects(peer.request('chat.option.set', { sessionId: session.id, leaseEpoch, optionId: 'model', value: 'timeout', operationId: randomUUID() }, 45_000));
      assert.equal(setting(await peer.request('chat.options', { sessionId: session.id }), 'model'), 'legacy-model');
      assert.equal((await frames()).slice(timeoutStart).some(row => row.method === 'session/set_model'), false);
      checks.push(`${provider}: timed-out model change is not retried as legacy RPC`);
    }

    const disconnectStart = (await frames()).length;
    await assert.rejects(set(session.id, leaseEpoch, 'model', 'disconnect'));
    assert.equal((await frames()).slice(disconnectStart).some(row => row.method === 'session/set_model'), false);
    checks.push(`${provider}: disconnect does not fallback`);
  }
  assert.equal((await frames()).some(row => row.method === 'session/prompt'), false, 'fixture never sends a paid model prompt');
  console.log(JSON.stringify({ passed: true, checks, scratch, runtime }, null, 2));
} finally {
  peer?.close();
  if (daemon.exitCode === null) daemon.kill();
}
