// Real isolated runtime + supervised fake OpenCode HTTP/SSE regression.
// The fixture never contacts a model or approves a native permission.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { connectPeer } from './pipe-client.mjs';

const pause = ms => new Promise(done => setTimeout(done, ms));
const unique = () => randomUUID();
const root = await mkdtemp(join(tmpdir(), 'threadterm-opencode-chat-'));
const bin = join(root, 'bin');
const data = join(root, 'data');
const cwd = join(root, 'workspace');
const stateFile = join(root, 'mock-state.json');
const portFile = join(root, 'mock-port.txt');
const requestsFile = join(root, 'mock-requests.jsonl');
const pipe = `\\\\.\\pipe\\threadterm-opencode-chat-${unique()}`;
await Promise.all([mkdir(bin), mkdir(cwd)]);
const shim = 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}';
await writeFile(join(bin, 'shim.rs'), shim);
const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'opencode.exe')], { encoding: 'utf8', windowsHide: true });
assert.equal(compiled.status, 0, compiled.stderr);
const runtimeBin = process.env.THREADTERM_QA_RUNTIME_EXE || resolve('runtime/target/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtimeBin), `runtime binary missing: ${runtimeBin}`);
const runtimeCopy = join(root, 'runtime.exe');
await copyFile(runtimeBin, runtimeCopy);
const environment = {
  ...process.env,
  Path: [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_DATA: data,
  THREADTERM_V3_PIPE: pipe,
  TT_QA_NODE: process.execPath,
  TT_QA_SCRIPT: resolve('qa/fixtures/mock-opencode.mjs'),
  TT_QA_OPENCODE_STATE: stateFile,
  TT_QA_OPENCODE_PORT_FILE: portFile,
  TT_QA_OPENCODE_REQUESTS: requestsFile,
};
const daemon = spawn(runtimeCopy, [], { env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let diagnostic = '';
daemon.stderr.on('data', bytes => { diagnostic += bytes.toString(); });
let peer;
let sessionId;
let leaseEpoch;
let renewTimer;
let renewFailure;
const waitFor = async (read, accept, label, attempts = 160) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
};
const items = () => peer.request('chat.read', { sessionId });
const parts = async () => (await items()).flatMap(item => item.parts);
const requests = async () => (await readFile(requestsFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const session = async () => (await peer.request('runtime.snapshot')).sessions.find(row => row.id === sessionId);
const native = async (path, body) => {
  const port = Number(await readFile(portFile, 'utf8'));
  const response = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(response.ok, true, `${path}: ${response.status}`);
  return response.json();
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
  const created = await peer.request('session.create', { cwd, title: 'OpenCode fixture', provider: 'opencode', mode: 'chat', operationId: unique() });
  sessionId = created.id;
  leaseEpoch = (await peer.request('session.claim', { sessionId, clientId })).leaseEpoch;
  renewTimer = setInterval(() => {
    void peer.request('session.renew', { sessionId, leaseEpoch })
      .then(renewed => { leaseEpoch = renewed.leaseEpoch; })
      .catch(error => { renewFailure = error; });
  }, 10_000);
  const connected = await peer.request('chat.connect', { sessionId, leaseEpoch, operationId: unique() });
  assert.equal(connected.phase, 'ready');
  const nativeId = (await session()).nativeId;
  assert.ok(nativeId, 'native identity bound');
  const send = text => peer.request('chat.send', { sessionId, text, leaseEpoch, operationId: unique() });
  await send('fixture-two-parts');
  await waitFor(parts, rows => rows.some(row => row.text === 'FIRST-PART') && rows.some(row => row.text === 'SECOND-PART'), 'two distinct native messages persisted');
  await waitFor(session, row => row.status === 'idle', 'first turn ended');
  await send('fixture-delta');
  await waitFor(parts, rows => rows.some(row => row.text === 'Hello world'), 'deltas accumulated');
  await waitFor(session, row => row.status === 'idle', 'delta turn ended');
  assert.equal((await parts()).filter(row => row.text === 'Hello world').length, 1, 'delta is one part');
  await send('fixture-seed');
  await waitFor(parts, rows => rows.some(row => row.text === 'A'), 'message for snapshot/delta race');
  await waitFor(session, row => row.status === 'idle', 'seed turn ended');
  const beforeRace = JSON.parse(await readFile(stateFile, 'utf8'));
  const nativeRecord = Object.values(beforeRace.sessions).find(row => row.id === nativeId);
  const seedMessage = nativeRecord.messages.find(row => row.parts.some(part => part.text === 'A'));
  assert.ok(seedMessage, 'native seed message retained');

  await send('fixture-early-idle');
  await waitFor(session, row => row.status === 'idle', 'native idle before HTTP acknowledgement remains idle');
  await send('fixture-early-permission');
  await waitFor(items, rows => rows.some(row => row.id === `${sessionId}:approval:per_early` && row.parts[0]?.status === 'pending'), 'approval event before HTTP prompt acknowledgement');
  assert.equal((await session()).status, 'waiting', 'late prompt acknowledgement cannot downgrade an already waiting native turn');
  await native('/qa/emit', { directory: cwd, type: 'permission.replied', properties: { sessionID: nativeId, requestID: 'per_early', reply: 'once' } });
  await native('/qa/status', { directory: cwd, sessionID: nativeId, busy: false });
  await native('/qa/emit', { directory: cwd, type: 'session.idle', properties: { sessionID: nativeId } });
  await waitFor(session, row => row.status === 'idle', 'early approval turn ended');

  await send('fixture-permission');
  await waitFor(items, rows => rows.filter(row => row.parts[0]?.type === 'approval' && row.parts[0]?.status === 'pending').length === 2, 'two pending approvals');
  const beforeApproval = await items();
  await native('/qa/emit', { directory: cwd, type: 'permission.replied', properties: { sessionID: nativeId, requestID: 'per_1', reply: 'once' } });
  await waitFor(items, rows => rows.find(row => row.id === `${sessionId}:approval:per_1`)?.parts[0]?.status === 'resolved', 'first card resolved');
  assert.equal((await items()).find(row => row.id === `${sessionId}:approval:per_2`).parts[0].status, 'pending', 'second card remains pending');
  const afterApproval = await items();
  await writeFile(join(root, 'chatview-state.json'), JSON.stringify({ sessionId, beforeApproval, afterApproval }));
  await native('/qa/emit', { directory: cwd, type: 'permission.replied', properties: { sessionID: nativeId, requestID: 'per_1', reply: 'once' } });
  await native('/qa/emit', { directory: cwd, type: 'permission.updated', properties: { sessionID: nativeId, id: 'per_1', permission: 'bash' } });
  await pause(100);
  assert.equal((await items()).find(row => row.id === `${sessionId}:approval:per_1`).parts[0].status, 'resolved', 'duplicate and late updates cannot reopen a card');
  assert.equal((await session()).status, 'waiting', 'second pending approval keeps the session waiting');
  await native('/qa/emit', { directory: cwd, type: 'session.idle', properties: { sessionID: 'ses_foreign' } });
  assert.equal((await session()).status, 'waiting', 'foreign idle cannot end current turn');

  await native('/qa/fail-status', { enabled: true });
  await native('/qa/drop-events');
  await waitFor(() => peer.request('chat.connection', { sessionId }), state => state.phase !== 'ready', 'SSE EOF invalidates connection');
  const beforeReconnect = (await parts()).filter(row => row.type === 'text' && row.text !== 'A').map(row => row.text);
  await assert.rejects(peer.request('chat.connect', { sessionId, leaseEpoch, operationId: unique() }), /status unavailable|provider_error/i, 'missing native status cannot report ready');
  const mockState = JSON.parse(await readFile(stateFile, 'utf8'));
  mockState.failStatus = false;
  mockState.stallEventHeaders = true;
  await writeFile(stateFile, JSON.stringify(mockState));
  const headerStart = Date.now();
  await assert.rejects(peer.request('chat.connect', { sessionId, leaseEpoch, operationId: unique() }), /headers were not received/i, 'half-open SSE headers fail bounded connect');
  assert.ok(Date.now() - headerStart < 8000, 'SSE header timeout stays bounded');
  const recoveredState = JSON.parse(await readFile(stateFile, 'utf8'));
  recoveredState.stallEventHeaders = false;
  recoveredState.seedRace = { sessionID: nativeId, messageID: seedMessage.info.id, partID: seedMessage.parts[0].id };
  await writeFile(stateFile, JSON.stringify(recoveredState));
  const reconnect = await peer.request('chat.connect', { sessionId, leaseEpoch, operationId: unique() });
  assert.equal(reconnect.phase, 'ready');
  assert.equal((await session()).nativeId, nativeId, 'reconnect retains native identity');
  await waitFor(parts, rows => rows.some(row => row.text === 'AB'), 'buffered delta uses authoritative seeded message');
  assert.equal((await parts()).some(row => row.text === 'ABB'), false, 'buffered delta is not appended twice');
  const promptCount = (await requests()).filter(row => row.path.endsWith('/prompt_async')).length;
  await assert.rejects(send('must-not-run'), error => error.code === 'turn_in_progress', 'natively busy turn blocks second send');
  assert.equal((await requests()).filter(row => row.path.endsWith('/prompt_async')).length, promptCount, 'blocked send never reaches native prompt endpoint');
  assert.equal((await parts()).some(row => row.text === 'must-not-run'), false, 'rejected send does not create a phantom user turn');
  assert.deepEqual((await parts()).filter(row => row.type === 'text' && row.text !== 'AB').map(row => row.text), beforeReconnect, 'reconnect preserves earlier reply text');
  await native('/qa/status', { directory: cwd, sessionID: nativeId, busy: false });
  await native('/qa/emit', { directory: cwd, type: 'session.idle', properties: { sessionID: nativeId } });
  await waitFor(session, row => row.status === 'idle', 'native busy turn settled');
  await send('after-reconnect');
  await waitFor(parts, rows => rows.some(row => row.text === 'echo:after-reconnect'), 'original native session accepts later turn');
  await waitFor(session, row => row.status === 'idle', 'post-reconnect turn ended');

  // A healthy native server emits heartbeat SSE data every 10 seconds even
  // when no model output exists. Quiet Chat content alone must not disconnect.
  await pause(37_000);
  assert.equal(renewFailure, undefined, 'QA control lease stays valid during native heartbeat observation');
  assert.equal((await peer.request('chat.connection', { sessionId })).phase, 'ready', 'healthy content-quiet stream remains ready across watchdog window');
  await send('fixture-watchdog-permission');
  await waitFor(items, rows => rows.filter(row => ['per_watch_1', 'per_watch_2'].some(id => row.id === `${sessionId}:approval:${id}` && row.parts[0]?.status === 'pending')).length === 2, 'watchdog fixture has two pending cards');
  const stalledPort = Number(await readFile(portFile, 'utf8'));
  await native('/qa/stall-events', { mode: 'comments' }); // leaves TCP open, sends only non-event comments
  await waitFor(() => peer.request('chat.connection', { sessionId }), state => state.phase !== 'ready', 'silent established SSE invalidates connection', 800);
  await waitFor(items, rows => rows.filter(row => ['per_watch_1', 'per_watch_2'].some(id => row.id === `${sessionId}:approval:${id}` && row.parts[0]?.status === 'expired')).length === 2, 'watchdog expires only outstanding approvals');
  assert.equal(peer.events.filter(event => event.event === 'chat.connection' && event.data?.phase === 'disconnected' && event.data?.sessionId === sessionId).length >= 1, true, 'watchdog publishes a disconnected connection');
  await waitFor(async () => {
    try { await fetch(`http://127.0.0.1:${stalledPort}/global/health`, { signal: AbortSignal.timeout(500) }); return false; }
    catch { return true; }
  }, Boolean, 'retired silent worker releases its owned server and blocked reader');
  const beforeWatchdogRetry = (await requests()).filter(row => row.path.endsWith('/prompt_async')).length;
  await assert.rejects(send('not-replayed-after-silence'), /disconnected|not ready|turn_in_progress|chat_not_open/i, 'silent SSE cannot accept a new prompt');
  assert.equal((await requests()).filter(row => row.path.endsWith('/prompt_async')).length, beforeWatchdogRetry, 'silent SSE cannot dispatch native prompt');
  assert.equal((await parts()).some(row => row.text === 'not-replayed-after-silence'), false, 'silent SSE rejection does not persist a phantom user item');
  const watchdogReconnect = await peer.request('chat.connect', { sessionId, leaseEpoch, operationId: unique() });
  assert.equal(watchdogReconnect.phase, 'ready', 'explicit retry reconnects a new SSE stream');
  assert.equal((await session()).nativeId, nativeId, 'watchdog reconnect preserves the native session');
  await assert.rejects(send('still-native-busy'), error => error.code === 'turn_in_progress', 'native busy state is recalibrated after silent SSE reconnect');
  await native('/qa/status', { directory: cwd, sessionID: nativeId, busy: false });
  await native('/qa/emit', { directory: cwd, type: 'session.idle', properties: { sessionID: nativeId } });
  await waitFor(session, row => row.status === 'idle', 'reconnected native turn settled');

  // A partial SSE `data:` line with periodic bytes must not postpone the
  // watchdog merely because the transport read keeps making progress.
  await native('/qa/stall-events', { mode: 'partial' });
  await waitFor(() => peer.request('chat.connection', { sessionId }), state => state.phase !== 'ready', 'partial SSE frame cannot keep a stream ready', 800);
  const afterPartial = await peer.request('chat.connect', { sessionId, leaseEpoch, operationId: unique() });
  assert.equal(afterPartial.phase, 'ready');
  assert.equal((await session()).nativeId, nativeId);
  await send('after-partial-frame');
  await waitFor(parts, rows => rows.some(row => row.text === 'echo:after-partial-frame'), 'explicit reconnect after partial frame remains usable');
  await waitFor(session, row => row.status === 'idle', 'post-partial turn ended');

  await send('fixture-early-error');
  await waitFor(session, row => row.status === 'error', 'native error before HTTP acknowledgement remains failed');

  await native('/qa/bad-snapshot', { messageID: seedMessage.info.id });
  await native('/qa/emit', { directory: cwd, type: 'message.part.updated', properties: { sessionID: nativeId, part: { id: seedMessage.parts[0].id, messageID: seedMessage.info.id, sessionID: nativeId, type: 'text', text: 'HACK' } } });
  await waitFor(() => peer.request('chat.connection', { sessionId }), state => state.phase !== 'ready', 'wrong native snapshot identity fails connection');
  assert.equal((await parts()).some(row => row.text === 'AB'), true, 'invalid snapshot cannot overwrite persisted reply');
  assert.equal((await parts()).some(row => row.text === 'HACK'), false, 'invalid snapshot is not projected');
  const lastReconnect = await peer.request('chat.connect', { sessionId, leaseEpoch, operationId: unique() });
  assert.equal(lastReconnect.phase, 'ready');
  await assert.rejects(send('fixture-http-reject'), /422|fixture rejects prompt/i, 'definite native HTTP rejection is visible');
  await waitFor(session, row => row.status === 'error', 'definite prompt rejection cannot leave a running turn');
  await waitFor(parts, rows => rows.some(row => row.type === 'error' && /fixture rejects prompt/i.test(row.text)), 'definite prompt rejection persists an error part');

  const uncertain = await peer.request('session.create', { cwd, title: 'OpenCode uncertain prompt', provider: 'opencode', mode: 'chat', operationId: unique() });
  const uncertainLease = (await peer.request('session.claim', { sessionId: uncertain.id, clientId })).leaseEpoch;
  assert.equal((await peer.request('chat.connect', { sessionId: uncertain.id, leaseEpoch: uncertainLease, operationId: unique() })).phase, 'ready');
  const beforeUncertainPrompt = (await requests()).filter(row => row.path.endsWith('/prompt_async')).length;
  await assert.rejects(peer.request('chat.send', { sessionId: uncertain.id, text: 'fixture-early-permission-http-fail', leaseEpoch: uncertainLease, operationId: unique() }), /503|native action may already be waiting/i, '5xx after native approval is not assumed rejected');
  await waitFor(() => peer.request('chat.connection', { sessionId: uncertain.id }), state => state.phase !== 'ready', 'uncertain native prompt retires its worker');
  await waitFor(() => peer.request('chat.read', { sessionId: uncertain.id }), rows => rows.some(row => row.id === `${uncertain.id}:approval:per_early_fail` && row.parts[0]?.status === 'expired'), 'uncertain prompt expires the already emitted approval');
  assert.equal((await requests()).filter(row => row.path.endsWith('/prompt_async')).length, beforeUncertainPrompt + 1, 'uncertain native prompt is never automatically replayed');
  console.log(JSON.stringify({ passed: true, checks: ['message identity', 'delta assembly', 'approval identity', 'foreign event', 'SSE EOF', 'same-native busy reconnect', 'seeded delta race', 'healthy idle heartbeat', 'established SSE comments', 'partial SSE frame', 'early native result before HTTP acknowledgement', 'definite HTTP rejection', 'uncertain 5xx after native approval', 'invalid snapshot fencing'], root }));
} catch (error) {
  let snapshot, transcript;
  try { snapshot = await peer?.request('runtime.snapshot'); transcript = sessionId ? await items() : undefined; } catch {}
  console.error(JSON.stringify({ passed: false, root, diagnostic, events: peer?.events.slice(-20), snapshot, transcript, error: error instanceof Error ? error.stack : String(error) }));
  throw error;
} finally {
  if (renewTimer) clearInterval(renewTimer);
  if (peer) { try { await peer.request('runtime.shutdown', { operationId: unique() }); } catch {} peer.close(); }
  if (daemon.exitCode === null) await Promise.race([new Promise(done => daemon.once('exit', done)), pause(3000)]);
  if (daemon.exitCode === null) daemon.kill();
}
