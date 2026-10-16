// Isolated OpenCode option persistence QA. Uses only the fake HTTP/SSE server.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { connectSubagentPeer as connectPeer } from './lib/subagent-peer.mjs';

const delay = ms => new Promise(done => setTimeout(done, ms));
const scratchRoot = resolve(process.env.THREADTERM_QA_SCRATCH ?? 'D:/project/ThreadTerm/tt-qa-temp');
await mkdir(scratchRoot, { recursive: true });
process.env.TMP = scratchRoot; process.env.TEMP = scratchRoot;
const root = await mkdtemp(join(scratchRoot, 'threadterm-opencode-options-persistence-'));
const bin = join(root, 'bin'), data = join(root, 'data'), workspace = join(root, 'workspace');
const stateFile = join(root, 'mock-state.json'), portFile = join(root, 'mock-port.txt'), requestsFile = join(root, 'mock-requests.jsonl');
const pipe = String.raw`\\.\pipe\threadterm-opencode-options-persistence-${randomUUID()}`;
await Promise.all([mkdir(bin), mkdir(data), mkdir(workspace), writeFile(requestsFile, '')]);
const shim = 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}';
await writeFile(join(bin, 'shim.rs'), shim);
const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'opencode.exe')], { encoding: 'utf8', windowsHide: true });
assert.equal(compiled.status, 0, compiled.stderr);
const runtimeSource = process.env.THREADTERM_QA_RUNTIME_EXE || resolve('runtime/target/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtimeSource), `runtime binary missing: ${runtimeSource}`);
const runtime = join(root, 'runtime.exe'); await copyFile(runtimeSource, runtime);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')),
  Path: [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
  TMP: scratchRoot, TEMP: scratchRoot, THREADTERM_V3_DATA: data, THREADTERM_V3_PIPE: pipe,
  TT_QA_NODE: process.execPath, TT_QA_SCRIPT: resolve('qa/fixtures/mock-opencode.mjs'),
  TT_QA_OPENCODE_STATE: stateFile, TT_QA_OPENCODE_PORT_FILE: portFile, TT_QA_OPENCODE_REQUESTS: requestsFile,
};
let daemon, peer;
async function start() {
  daemon = spawn(runtime, [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = ''; daemon.stderr.on('data', bytes => { diagnostic += bytes; });
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try { peer = await connectPeer(`${pipe}-control`); return await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim()); }
    catch { peer?.close(); peer = undefined; if (daemon.exitCode !== null) throw new Error(diagnostic); await delay(50); }
  }
  throw new Error('runtime did not accept an isolated control connection');
}
async function stop() {
  try { await peer?.request('runtime.shutdown', { operationId: randomUUID() }); } catch {}
  peer?.close(); peer = undefined;
  if (daemon?.exitCode === null) await Promise.race([new Promise(done => daemon.once('exit', done)), delay(5000)]);
  if (daemon?.exitCode === null) daemon.kill();
}
const options = sessionId => peer.request('chat.options', { sessionId });
const option = (ui, id) => ui.options.find(row => row.id === id);
try {
  let clientId = await start();
  const created = await peer.request('session.create', { cwd: workspace, title: 'OpenCode option persistence', provider: 'opencode', mode: 'chat', operationId: randomUUID() });
  let leaseEpoch = (await peer.request('session.claim', { sessionId: created.id, clientId })).leaseEpoch;
  assert.equal((await peer.request('chat.connect', { sessionId: created.id, leaseEpoch, operationId: randomUUID() })).phase, 'ready');
  const set = (optionId, value) => peer.request('chat.option.set', { sessionId: created.id, leaseEpoch, optionId, value, operationId: randomUUID() });
  await set('next-model', '{"providerID":"openai","modelID":"gpt-5.2"}'); await set('agent', 'plan'); await set('variant', 'precise');
  await stop();
  clientId = await start();
  leaseEpoch = (await peer.request('session.claim', { sessionId: created.id, clientId })).leaseEpoch;
  assert.equal((await peer.request('chat.connect', { sessionId: created.id, leaseEpoch, operationId: randomUUID() })).phase, 'ready');
  const restored = await options(created.id);
  assert.equal(option(restored, 'next-model').value, '{"providerID":"openai","modelID":"gpt-5.2"}');
  assert.equal(option(restored, 'agent').value, 'plan'); assert.equal(option(restored, 'variant').value, 'precise');
  console.log(JSON.stringify({ passed: true, checks: ['same-data daemon restart restores model, agent, and variant'], root }));
} finally { await stop(); }
