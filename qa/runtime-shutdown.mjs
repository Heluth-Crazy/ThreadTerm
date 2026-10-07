// Real-runtime regression: runtime.shutdown ends every live terminal within one shared grace period.
//   node qa/runtime-shutdown.mjs        (needs runtime/target-qa/debug/threadterm-v3-runtime.exe)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { PROTOCOL_CONTRACT, PROTOCOL_VERSION } from '../protocol/index.ts';

const delay = ms => new Promise(done => setTimeout(done, ms));
const root = resolve(import.meta.dirname, '..');
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE || join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
assert.ok(existsSync(runtime), `Missing QA runtime: ${runtime}`);
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-runtime-shutdown-'));
const data = join(scratch, 'data'), project = join(scratch, 'project');
const pipe = `\\\\.\\pipe\\threadterm-runtime-shutdown-${randomUUID()}`;
const peers = [];
let daemon, stderr = '';
const live = new Set(['starting', 'running', 'idle', 'waiting']);
const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH'));
isolatedEnv.Path = [dirname(process.execPath), join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32')].join(delimiter);

class Peer {
  queue = []; waiters = []; pending = Buffer.alloc(0); closed = false;
  constructor(socket) {
    this.socket = socket;
    socket.on('data', bytes => {
      this.pending = Buffer.concat([this.pending, bytes]);
      while (this.pending.length >= 4) {
        const length = this.pending.readUInt32LE();
        if (this.pending.length < length + 4) break;
        const frame = this.pending.subarray(4, length + 4);
        this.pending = this.pending.subarray(length + 4);
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(frame); else this.queue.push(frame);
      }
    });
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(Error('Runtime pipe closed')));
  }
  fail(error) { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter.reject(error); }
  next(timeout = 10_000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(Error('Runtime pipe closed'));
    return new Promise((resolveNext, rejectNext) => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter(item => item !== waiter); rejectNext(Error('Runtime frame timed out')); }, timeout);
      const waiter = { resolve: frame => { clearTimeout(timer); resolveNext(frame); }, reject: error => { clearTimeout(timer); rejectNext(error); } };
      this.waiters.push(waiter);
    });
  }
  json(value) { const bytes = Buffer.from(JSON.stringify(value)); const frame = Buffer.alloc(bytes.length + 4); frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4); this.socket.write(frame); }
  async auth(credential, clientId) {
    const challenge = JSON.parse(await this.next());
    this.json({ kind: 'auth', clientId, protocol: PROTOCOL_VERSION, contract: PROTOCOL_CONTRACT, nonce: challenge.nonce,
      hmac: createHmac('sha256', credential).update(`${PROTOCOL_VERSION}:${clientId}:${challenge.nonce}`).digest('hex') });
    const proof = JSON.parse(await this.next());
    assert.equal(proof.kind, 'authenticated', JSON.stringify(proof));
    assert.equal(proof.principal, clientId);
  }
  async request(method, params = {}) {
    const id = randomUUID(); this.json({ v: 1, id, method, params });
    for (;;) {
      const message = JSON.parse(await this.next());
      if (message.id !== id) continue;
      if (message.error) throw Object.assign(Error(message.error.message), { code: message.error.code });
      return message.result;
    }
  }
  close() { this.socket.destroy(); }
}

async function connectControl(credential, clientId) {
  const socket = await new Promise((done, failed) => {
    const candidate = net.createConnection(`${pipe}-control`);
    candidate.once('connect', () => done(candidate));
    candidate.once('error', failed);
  });
  const peer = new Peer(socket);
  peers.push(peer);
  await peer.auth(credential, clientId);
  return peer;
}

async function startRuntime() {
  stderr = '';
  daemon = spawn(runtime, [], { env: { ...isolatedEnv, THREADTERM_V3_DATA: data, THREADTERM_V3_PIPE: pipe }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  daemon.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
  let lastError;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const credential = (await readFile(join(data, 'runtime.credential'), 'utf8')).trim();
      (await connectControl(credential, `probe-${randomUUID()}`)).close();
      return credential;
    } catch (error) {
      lastError = error;
      if (daemon.exitCode !== null) throw Error(`Runtime exited during startup (${daemon.exitCode}): ${stderr}`);
      await delay(100);
    }
  }
  throw Error(`Runtime startup timed out: ${lastError?.message ?? lastError}`);
}

async function waitForPrompt(peer, sessionId, epoch, marker) {
  let cursor = 0, output = '';
  await peer.request('terminal.input', { sessionId, data: `echo ${marker}\r`, leaseEpoch: epoch });
  for (const end = Date.now() + 15_000; Date.now() < end; await delay(80)) {
    const page = await peer.request('terminal.read', { sessionId, cursor, limit: 65_536 });
    if (page.nextCursor > cursor) { output += Buffer.from(page.data, 'base64').toString('utf8'); cursor = page.nextCursor; }
    if (output.split(marker).length > 2) return;
  }
  throw Error(`cmd did not print ${marker}`);
}

async function shutdownWithin(peer, budget = 5_000) {
  const exited = new Promise(done => daemon.once('exit', done));
  const started = Date.now();
  await Promise.race([
    (async () => {
      // Acknowledge receipt like desktop/src/runtime-client.ts; without it the runtime waits a 2 s drain window.
      const id = randomUUID(); peer.json({ v: 1, id, method: 'runtime.shutdown', params: { operationId: randomUUID() } });
      for (;;) {
        const message = JSON.parse(await peer.next());
        if (message.id !== id) continue;
        if (message.error) throw Object.assign(Error(message.error.message), { code: message.error.code });
        peer.json({ kind: 'shutdownAck', id });
        break;
      }
      await exited;
    })(),
    delay(budget).then(() => { throw Error(`runtime.shutdown did not acknowledge and exit within ${budget} ms`); }),
  ]);
  console.log(`PASS runtime.shutdown exited in ${Date.now() - started} ms (budget ${budget} ms)`);
}

try {
  await mkdir(data); await mkdir(project);
  let credential = await startRuntime();
  const peer = await connectControl(credential, `shutdown-qa-${randomUUID()}`);
  const projectRow = await peer.request('project.add', { path: project, name: 'Runtime shutdown QA', operationId: randomUUID() });
  const terminals = [];
  for (let index = 0; index < 3; index += 1) {
    const terminal = await peer.request('session.create', { projectId: projectRow.id, cwd: project, title: `Shutdown terminal ${index + 1}`,
      provider: 'shell', mode: 'terminal', executable: 'cmd.exe', args: ['/Q', '/K'], operationId: randomUUID() });
    terminals.push(terminal);
    const { leaseEpoch } = await peer.request('session.claim', { sessionId: terminal.id });
    await waitForPrompt(peer, terminal.id, leaseEpoch, `RUNTIME_SHUTDOWN_READY_${index}`);
  }
  console.log('PASS opened and verified three live cmd.exe terminals');

  await shutdownWithin(peer, 3_500);
  credential = await startRuntime();
  const restarted = await connectControl(credential, `shutdown-qa-restarted-${randomUUID()}`);
  const snapshot = await restarted.request('runtime.snapshot');
  for (const terminal of terminals) {
    const session = snapshot.sessions.find(item => item.id === terminal.id);
    assert.ok(session, `missing session ${terminal.id} after restart`);
    assert.equal(live.has(session.status), false, `session ${terminal.id} remained live as ${session.status}`);
    assert.equal(session.status, 'exited', `session ${terminal.id} lost its exited status`);
    assert.equal(snapshot.inbox.some(item => item.sessionId === terminal.id), false, `session ${terminal.id} added an Inbox item`);
  }
  console.log('PASS restart preserved ended terminals and no Inbox items');
  await shutdownWithin(restarted, 1_500);
  console.log('RUNTIME SHUTDOWN QA PASSED');
} catch (error) {
  console.error(error);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
} finally {
  for (const peer of peers) peer.close();
  if (daemon?.exitCode === null) {
    const exited = new Promise(done => daemon.once('exit', done));
    daemon.kill();
    await Promise.race([exited, delay(5_000)]);
  }
  const target = resolve(scratch);
  assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}threadterm-runtime-shutdown-`), `Refusing cleanup outside scratch: ${target}`);
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
