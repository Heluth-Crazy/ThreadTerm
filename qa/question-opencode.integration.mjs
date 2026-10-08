// Isolated OpenCode question regression. The only executable provider is the
// local HTTP/SSE fixture behind a rustc shim; PATH contains no real agent CLI.
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
const root = await mkdtemp(join(tmpdir(), 'threadterm-opencode-question-'));
const bin = join(root, 'bin'), data = join(root, 'data'), cwd = join(root, 'workspace');
const stateFile = join(root, 'mock-state.json'), portFile = join(root, 'mock-port.txt'), requestsFile = join(root, 'mock-requests.jsonl');
const pipe = `\\\\.\\pipe\\threadterm-opencode-question-${unique()}`;
await Promise.all([mkdir(bin), mkdir(cwd)]);
await writeFile(join(bin, 'shim.rs'), 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}');
const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'opencode.exe')], { encoding: 'utf8', windowsHide: true });
assert.equal(compiled.status, 0, compiled.stderr);
const runtime = process.env.THREADTERM_QA_RUNTIME_EXE || resolve('runtime/target/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtime), `runtime binary missing: ${runtime}`);
const runtimeCopy = join(root, 'runtime.exe'); await copyFile(runtime, runtimeCopy);
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')),
  Path: [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_DATA: data, THREADTERM_V3_PIPE: pipe, TT_QA_NODE: process.execPath,
  TT_QA_SCRIPT: resolve('qa/fixtures/mock-opencode.mjs'), TT_QA_OPENCODE_STATE: stateFile,
  TT_QA_OPENCODE_PORT_FILE: portFile, TT_QA_OPENCODE_REQUESTS: requestsFile,
};
assert.deepEqual(Object.keys(environment).filter(key => key.toLowerCase() === 'path'), ['Path']);
const daemon = spawn(runtimeCopy, [], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let diagnostic = '', lastConnectError, peer, sessionId, leaseEpoch;
daemon.stdout.on('data', bytes => { diagnostic += bytes; }); daemon.stderr.on('data', bytes => { diagnostic += bytes; });
const waitFor = async (read, accept, label) => { for (let i = 0; i < 160; i += 1) { const value = await read(); if (accept(value)) return value; await pause(50); } throw new Error(`Timed out: ${label}`); };
const items = () => peer.request('chat.read', { sessionId });
const state = async () => JSON.parse(await readFile(stateFile, 'utf8'));
const native = async (path, body) => {
  const port = Number(await readFile(portFile, 'utf8'));
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.ok, true, `${path}: ${response.status}`);
};
const session = async () => (await peer.request('runtime.snapshot')).sessions.find(row => row.id === sessionId);
try {
  let clientId;
  for (let i = 0; i < 300; i += 1) {
    try {
      peer = await connectPeer(`${pipe}-control`);
      clientId = await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      break;
    } catch (error) {
      lastConnectError = error;
      peer?.close(); peer = undefined;
      if (daemon.exitCode !== null) throw new Error(diagnostic);
      await pause(50);
    }
  }
  assert.ok(peer, `isolated runtime authenticated: ${lastConnectError instanceof Error ? lastConnectError.message : String(lastConnectError)}`);
  const created = await peer.request('session.create', { cwd, title: 'OpenCode questions', provider: 'opencode', mode: 'chat', operationId: unique() });
  sessionId = created.id; leaseEpoch = (await peer.request('session.claim', { sessionId, clientId })).leaseEpoch;
  await peer.request('chat.connect', { sessionId, leaseEpoch, operationId: unique() });
  const send = text => peer.request('chat.send', { sessionId, text, leaseEpoch, operationId: unique() });
  await send('fixture-question');
  const root = (await waitFor(items, rows => rows.some(row => row.parts[0]?.approvalId === 'q_root'), 'root question')).find(row => row.parts[0]?.approvalId === 'q_root');
  const rootPart = root.parts[0];
  assert.equal(rootPart.data.interaction, 'question'); assert.equal(rootPart.data.form.questions[0].multiSelect, true); assert.equal(rootPart.data.form.questions[1].allowOther, false);
  await peer.request('chat.answer', { sessionId, turnId: root.turnId, approvalId: 'q_root', leaseEpoch, operationId: unique(), response: { action: 'submit', values: { q0: ['Red', 'Blue'], q1: ['Safe'] } } });
  await waitFor(items, rows => rows.find(row => row.id === `${sessionId}:approval:q_root`)?.parts[0]?.status === 'answered', 'root answer resolution');
  await waitFor(session, row => ['idle', 'awaiting_input'].includes(row.activity?.state ?? row.status), 'root question turn completes');
  assert.deepEqual((await state()).questionReplies.find(row => row.requestID === 'q_root'), { requestID: 'q_root', action: 'reply', answers: [['Red', 'Blue'], ['Safe']], sessionID: (await state()).questions.q_root.sessionID });
  await send('fixture-child-question');
  const child = (await waitFor(items, rows => rows.some(row => row.parts[0]?.approvalId === 'q_child'), 'buffered child question')).find(row => row.parts[0]?.approvalId === 'q_child');
  assert.equal(child.parts[0].data.subagent.key, 'call_question_1');
  await peer.request('chat.answer', { sessionId, turnId: child.turnId, approvalId: 'q_child', leaseEpoch, operationId: unique(), response: { action: 'dismiss' } });
  await waitFor(items, rows => rows.find(row => row.id === `${sessionId}:approval:q_child`)?.parts[0]?.status === 'dismissed', 'child dismissal');
  assert.equal((await state()).questionReplies.find(row => row.requestID === 'q_child').action, 'reject');
  await native('/qa/emit', { directory: cwd, type: 'question.asked', properties: { sessionID: (await state()).questions.q_root.sessionID, id: 'q_external', questions: [{ question: 'External choice?', options: [{ label: 'Yes' }] }] } });
  const external = (await waitFor(items, rows => rows.some(row => row.parts[0]?.approvalId === 'q_external'), 'external-client question')).find(row => row.parts[0]?.approvalId === 'q_external');
  await native('/qa/emit', { directory: cwd, type: 'question.replied', properties: { sessionID: (await state()).questions.q_root.sessionID, requestID: 'q_external', answers: [['Yes']] } });
  await waitFor(items, rows => rows.find(row => row.id === `${sessionId}:approval:q_external`)?.parts[0]?.status === 'answered', 'external native resolution');
  assert.deepEqual((await items()).find(row => row.id === `${sessionId}:approval:q_external`).parts[0].data.answerSummary, { q0: 'Yes' });
  assert.equal(external.parts[0].data.form.questions[0].question, 'External choice?');
  assert.equal((await state()).questionReplies.some(row => row.requestID === 'q_external'), false, 'external resolution sends no local POST');
  console.log(JSON.stringify({ passed: true, checks: ['PATH isolation', 'root ordered multi-question reply', 'native answer summary', 'buffered child question label', 'child reject endpoint', 'external-client resolution without local POST'] }));
} catch (error) { console.error(JSON.stringify({ passed: false, root, diagnostic, error: error instanceof Error ? error.stack : String(error) })); throw error; }
finally { if (peer) { try { await peer.request('runtime.shutdown', { operationId: unique() }); } catch {} peer.close(); } if (daemon.exitCode === null) await Promise.race([new Promise(done => daemon.once('exit', done)), pause(3000)]); if (daemon.exitCode === null) daemon.kill(); }
