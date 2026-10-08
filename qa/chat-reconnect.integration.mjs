// Supplemental native-pipe QA; no desktop/window and no real agent CLI.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { connectSubagentPeer } from './lib/subagent-peer.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-reconnect-pipe-'));
const bin = join(scratch, 'bin'), cwd = join(scratch, 'workspace'), data = join(scratch, 'data'), control = join(scratch, 'control');
const log = join(scratch, 'fake.jsonl'), out = resolve('qa/results/chat-reconnect');
await Promise.all([bin, cwd, control, out].map(path => mkdir(path, { recursive: true })));
const pipe = `\\\\.\\pipe\\threadterm-reconnect-pipe-${randomUUID()}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'codex_home', 'openai_api_key', 'threadterm_v3_data', 'threadterm_v3_pipe'].includes(key.toLowerCase())));
Object.assign(env, {
  Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_DATA: data, THREADTERM_V3_PIPE: pipe, CODEX_HOME: join(scratch, 'provider-home'),
  TT_QA_NODE: process.execPath, TT_QA_SCRIPT: resolve('qa/fixtures/fake-codex-reconnect.cjs'),
  THREADTERM_QA_CODEX_RECONNECT_LOG: log, THREADTERM_QA_CODEX_RECONNECT_CWD: cwd, THREADTERM_QA_CODEX_RECONNECT_CONTROL: control,
});
assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path']);
await writeFile(log, '');
await writeFile(join(bin, 'shim.rs'), 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}');
const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'codex.exe')], { encoding: 'utf8', windowsHide: true });
assert.equal(compiled.status, 0, compiled.stderr);
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE ?? 'runtime/target/debug/threadterm-v3-runtime.exe');
const daemon = spawn(runtime, [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let diagnostic = '', peer;
daemon.stderr.on('data', bytes => { diagnostic += bytes.toString(); });
const report = { passed: false, scratch, runtime, checks: [] };
const pause = ms => new Promise(done => setTimeout(done, ms));
async function until(read, accepts, label) {
  for (let i = 0; i < 200; i++) { const value = await read(); if (accepts(value)) return value; await pause(50); }
  throw new Error(`Timed out: ${label}`);
}
async function connect() {
  const next = await connectSubagentPeer(`${pipe}-control`);
  await next.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
  return next;
}
try {
  await until(async () => {
    try { peer = await connect(); return true; } catch { if (daemon.exitCode !== null) throw new Error(diagnostic); return false; }
  }, Boolean, 'runtime authentication');
  const session = await peer.request('session.create', { cwd, provider: 'codex', mode: 'chat', title: 'Pipe reconnect QA', operationId: randomUUID() });
  const { leaseEpoch } = await peer.request('session.claim', { sessionId: session.id });
  assert.equal((await peer.request('chat.connect', { sessionId: session.id, leaseEpoch, operationId: randomUUID() })).phase, 'ready');
  await peer.request('chat.send', { sessionId: session.id, text: 'reconnect', leaseEpoch, operationId: randomUUID() });
  const before = await until(() => peer.request('chat.snapshot', { sessionId: session.id }), snapshot => snapshot.items.some(item => item.parts.some(part => part.type === 'approval' && part.status === 'pending')), 'pre-gap pending approval');
  const uiEvent = await peer.nextEvent(event => event.event === 'chat.ui' && event.data.sessionId === session.id);
  assert.equal(uiEvent.data.inputCapabilities.images, true, 'actual outbox UI carries image capability');
  assert.equal(uiEvent.data.loadState, 'ready');
  peer.close(); peer = undefined;
  await writeFile(join(control, 'release'), 'release\n');
  await until(() => readFile(log, 'utf8'), text => text.includes('"method":"turn/completed"'), 'provider completed during control gap');
  peer = await connect();
  await until(() => peer.request('runtime.snapshot'), snapshot => snapshot.sessions.find(row => row.id === session.id)?.status === 'idle', 'gap events persisted');
  const snapshot = await peer.request('chat.snapshot', { sessionId: session.id });
  const options = await peer.request('chat.options', { sessionId: session.id });
  assert.ok(snapshot.revision > before.revision);
  assert.equal(new Set(snapshot.items.map(item => item.id)).size, snapshot.items.length);
  assert.ok(snapshot.items.some(item => item.parts.some(part => part.text === 'GAP-FINAL-ANSWER')));
  assert.ok(snapshot.items.some(item => item.parts.some(part => part.type === 'tool')));
  assert.equal(snapshot.items.flatMap(item => item.parts).filter(part => part.type === 'approval' && part.status === 'pending').length, 0);
  assert.equal(options.options.find(option => option.id === 'model').value, 'qa-reconnect-b');
  assert.equal(options.inputCapabilities.images, true);
  const claim = await peer.request('session.claim', { sessionId: session.id });
  const changed = await peer.request('chat.option.set', { sessionId: session.id, optionId: 'model', value: 'qa-reconnect-a', leaseEpoch: claim.leaseEpoch, operationId: randomUUID() });
  assert.equal(changed.inputCapabilities.images, true);
  await peer.request('chat.send', { sessionId: session.id, text: '', images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WQAAAABJRU5ErkJggg=='], leaseEpoch: claim.leaseEpoch, operationId: randomUUID() });
  report.checks = ['authenticated native control pipe dropped mid-turn', 'complete chat.ui outbox snapshot preserves images/load state', 'gap text/tool/approval resolution/model captured in snapshot with unique IDs', 'model changed and image-only send accepted by runtime'];
  report.passed = true;
} catch (error) { report.error = error.stack ?? String(error); report.diagnostic = diagnostic; process.exitCode = 1; }
finally {
  if (peer) { await peer.request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {}); peer.close(); }
  if (daemon.exitCode === null) await Promise.race([new Promise(done => daemon.once('exit', done)), pause(3000)]);
  if (daemon.exitCode === null) daemon.kill();
  await writeFile(join(out, 'runtime-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
