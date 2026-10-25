// Runtime-level OpenCode subagent regression.  It launches only the local
// HTTP/SSE fixture through a rustc shim; the runtime cannot inherit a real
// OpenCode binary because every case-variant of PATH is removed below.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { connectSubagentPeer as connectPeer } from './lib/subagent-peer.mjs';

const pause = ms => new Promise(done => setTimeout(done, ms));
const unique = () => randomUUID();
const root = await mkdtemp(join(tmpdir(), 'threadterm-subagent-opencode-'));
const bin = join(root, 'bin');
const data = join(root, 'data');
const cwd = join(root, 'workspace');
const stateFile = join(root, 'mock-state.json');
const portFile = join(root, 'mock-port.txt');
const requestsFile = join(root, 'mock-requests.jsonl');
const pipe = `\\\\.\\pipe\\threadterm-subagent-opencode-${unique()}`;
await Promise.all([mkdir(bin), mkdir(cwd)]);

const shim = 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}';
await writeFile(join(bin, 'shim.rs'), shim);
const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'opencode.exe')], { encoding: 'utf8', windowsHide: true });
assert.equal(compiled.status, 0, compiled.stderr);
assert.ok(existsSync(join(bin, 'opencode.exe')), 'fake OpenCode rustc shim exists');
const runtimeBin = process.env.THREADTERM_QA_RUNTIME_EXE || process.env.THREADTERM_V3_RUNTIME_BIN || resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtimeBin), `runtime binary missing: ${runtimeBin}`);
const runtimeCopy = join(root, 'runtime.exe');
await copyFile(runtimeBin, runtimeCopy);
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')),
  Path: [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_DATA: data,
  THREADTERM_V3_PIPE: pipe,
  TT_QA_NODE: process.execPath,
  TT_QA_SCRIPT: resolve('qa/fixtures/mock-opencode.mjs'),
  TT_QA_OPENCODE_STATE: stateFile,
  TT_QA_OPENCODE_PORT_FILE: portFile,
  TT_QA_OPENCODE_REQUESTS: requestsFile,
};
const pathKeys = Object.keys(environment).filter(key => key.toLowerCase() === 'path');
assert.deepEqual(pathKeys, ['Path'], 'the runtime environment has exactly one PATH spelling');
assert.equal(environment.Path, [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'), 'PATH contains only the fake-provider shim, Node, and System32');
assert.equal(environment.TT_QA_SCRIPT, resolve('qa/fixtures/mock-opencode.mjs'), 'fake provider script is explicit');

const daemon = spawn(runtimeCopy, [], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let diagnostic = '';
daemon.stdout.on('data', bytes => { diagnostic += bytes.toString(); });
daemon.stderr.on('data', bytes => { diagnostic += bytes.toString(); });
let peer;
let sessionId;
let leaseEpoch;
const waitFor = async (read, accept, label, attempts = 160) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
};
const items = () => peer.request('chat.read', { sessionId });
const session = async () => (await peer.request('runtime.snapshot')).sessions.find(row => row.id === sessionId);
const requests = async () => {
  if (!existsSync(requestsFile)) return [];
  return (await readFile(requestsFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
};

try {
  let clientId;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      peer = await connectPeer(`${pipe}-control`);
      clientId = await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      break;
    } catch {
      peer?.close(); peer = undefined;
      if (daemon.exitCode !== null) throw new Error(diagnostic);
      await pause(50);
    }
  }
  assert.ok(peer, 'isolated runtime authenticated');
  const created = await peer.request('session.create', { cwd, title: 'OpenCode subagent fixture', provider: 'opencode', mode: 'chat', operationId: unique() });
  sessionId = created.id;
  leaseEpoch = (await peer.request('session.claim', { sessionId, clientId })).leaseEpoch;
  assert.equal((await peer.request('chat.connect', { sessionId, leaseEpoch, operationId: unique() })).phase, 'ready');
  await peer.request('chat.send', { sessionId, text: 'fixture-subagent-task', leaseEpoch, operationId: unique() });

  const card = await waitFor(items, rows => rows.find(row => row.parts.some(part => part.type === 'subagent' && part.data?.key === 'call_task_1')), 'subagent card');
  const subagent = card.flatMap(row => row.parts).find(part => part.type === 'subagent' && part.data?.key === 'call_task_1');
  assert.equal(subagent.status, 'running', 'running task metadata creates a live subagent card');

  const approval = await waitFor(items, rows => rows.find(row => row.parts.some(part => part.type === 'approval' && part.data?.approvalId === 'per_child_task')), 'child approval');
  const approvalItem = approval.find(row => row.parts.some(part => part.type === 'approval' && part.data?.approvalId === 'per_child_task'));
  const approvalPart = approvalItem.parts.find(part => part.type === 'approval' && part.data?.approvalId === 'per_child_task');
  assert.equal(approvalPart.data.subagent.key, 'call_task_1', 'child approval links its task card');
  assert.ok(approvalPart.data.subagent.label, 'child approval carries a subagent label');

  const transcript = await peer.request('chat.subagent.read', { sessionId, key: 'call_task_1' });
  assert.equal(transcript.source, 'live');
  assert.ok(transcript.items.some(item => item.parts.some(part => part.text === 'Child inspected the fixture.')), 'child text is available in the transcript');
  assert.ok(transcript.items.some(item => item.parts.some(part => part.type === 'tool' && part.toolName === 'read')), 'child tool is available in the transcript');

  await peer.request('chat.approve', { sessionId, turnId: approvalItem.turnId, approvalId: 'per_child_task', choiceId: 'allow', leaseEpoch, operationId: unique() });
  const childID = Object.values(JSON.parse(await readFile(stateFile, 'utf8')).sessions).find(row => row.id.startsWith('ses_child_'))?.id;
  assert.ok(childID, 'fixture created the child session');
  await waitFor(requests, rows => rows.some(row => row.method === 'POST' && row.path === `/session/${childID}/permissions/per_child_task`), 'approval POST to the child session');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.childPermissionApproved?.sessionID, childID, 'mock accepted the child-scoped permission reply');
  const completed = await waitFor(items, rows => rows.flatMap(row => row.parts).find(part => part.type === 'subagent' && part.data?.key === 'call_task_1' && part.status === 'completed'), 'completed subagent card');
  const completedCard = completed.flatMap(row => row.parts).find(part => part.type === 'subagent' && part.data?.key === 'call_task_1');
  assert.equal(completedCard.data.summary, 'Child found the fixture contents.', 'task completion keeps the child summary');
  await waitFor(session, row => row.status === 'idle', 'parent turn settles after child permission reply');
  console.log(JSON.stringify({ passed: true, root, checks: ['PATH isolation', 'task card completion and summary', 'child transcript text/tool', 'child approval label', 'child-scoped approval POST', 'parent idle after approval'] }));
} catch (error) {
  let snapshot;
  let transcript;
  try { snapshot = await peer?.request('runtime.snapshot'); transcript = sessionId ? await items() : undefined; } catch {}
  console.error(JSON.stringify({ passed: false, root, diagnostic, snapshot, transcript, error: error instanceof Error ? error.stack : String(error) }));
  throw error;
} finally {
  if (peer) { try { await peer.request('runtime.shutdown', { operationId: unique() }); } catch {} peer.close(); }
  if (daemon.exitCode === null) await Promise.race([new Promise(done => daemon.once('exit', done)), pause(3000)]);
  if (daemon.exitCode === null) daemon.kill();
}
