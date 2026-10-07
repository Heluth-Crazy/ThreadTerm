// Real-runtime regression: a restarted desktop (new principal) must not wait out the previous window's 30 s lease.
//   node qa/lease-restart-runtime.mjs        (needs runtime/target-qa/debug/threadterm-v3-runtime.exe)
// Covers both restart shapes: the old window's control pipe closes while the runtime keeps running, and the runtime
// itself restarts. The same principal reconnecting keeps its epoch; the departed one is fenced out.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { PROTOCOL_CONTRACT, PROTOCOL_VERSION } from '../protocol/index.ts';

const delay = ms => new Promise(done => setTimeout(done, ms));
const root = resolve(import.meta.dirname, '..');
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE || join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
assert.ok(existsSync(runtime), `Missing QA runtime: ${runtime}`);
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-lease-restart-'));
const data = join(scratch, 'data'), project = join(scratch, 'project');
const pipe = `\\\\.\\pipe\\threadterm-lease-restart-${randomUUID()}`;
const peers = [], checks = [];
let daemon, stderr = '';
const check = text => { checks.push(text); console.log(`PASS ${text}`); };

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
  const socket = await new Promise((done, failed) => { const candidate = net.createConnection(`${pipe}-control`); candidate.once('connect', () => done(candidate)); candidate.once('error', failed); });
  const peer = new Peer(socket);
  peers.push(peer);
  await peer.auth(credential, clientId);
  return peer;
}

async function startRuntime() {
  stderr = '';
  daemon = spawn(runtime, [], { env: { ...process.env, THREADTERM_V3_DATA: data, THREADTERM_V3_PIPE: pipe }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  daemon.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
  let lastError;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const credential = (await readFile(join(data, 'runtime.credential'), 'utf8')).trim();
      // Probe as a principal that never holds a lease.
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

async function stopRuntime(peer) {
  const exited = new Promise(done => daemon.once('exit', done)), started = Date.now();
  await peer.request('runtime.shutdown', { operationId: randomUUID() });
  await Promise.race([exited, delay(30_000).then(() => { throw Error('Runtime did not exit within 30 s of shutdown'); })]);
  console.log(`runtime exited ${Date.now() - started} ms after runtime.shutdown`);
}

const rejectsWith = (action, code) => assert.rejects(action, error => error?.code === code || error?.message === code);

async function echo(peer, sessionId, epoch, marker) {
  let cursor = 0, output = '';
  await peer.request('terminal.input', { sessionId, data: `echo ${marker}\r`, leaseEpoch: epoch });
  for (const end = Date.now() + 15_000; Date.now() < end; await delay(80)) {
    const page = await peer.request('terminal.read', { sessionId, cursor, limit: 65_536 });
    if (page.nextCursor > cursor) { output += Buffer.from(page.data, 'base64').toString('utf8'); cursor = page.nextCursor; }
    if (output.split(marker).length > 2) return; // the echoed command line plus its output
  }
  throw Error(`cmd did not print ${marker}`);
}

try {
  await mkdir(data); await mkdir(project);
  let credential = await startRuntime();
  const oldId = `old-window-${randomUUID()}`, newId = `new-window-${randomUUID()}`;
  let oldWindow = await connectControl(credential, oldId);
  const newWindow = await connectControl(credential, newId);
  const projectRow = await oldWindow.request('project.add', { path: project, name: 'Lease restart QA', operationId: randomUUID() });
  const terminal = title => oldWindow.request('session.create', { projectId: projectRow.id, cwd: project, title, provider: 'shell',
    mode: 'terminal', executable: 'cmd.exe', args: ['/Q', '/K'], operationId: randomUUID() });
  const first = await terminal('Lease restart A'), second = await terminal('Lease restart B');

  // 1. Desktop restart while the runtime keeps running.
  const held = (await oldWindow.request('session.claim', { sessionId: first.id })).leaseEpoch;
  await rejectsWith(() => newWindow.request('session.claim', { sessionId: first.id }), 'lease_held');
  check('a second window gets lease_held while the holder is connected');
  oldWindow.close();
  const closedAt = Date.now();
  let taken;
  while (!taken && Date.now() - closedAt < 5_000) {
    taken = await newWindow.request('session.claim', { sessionId: first.id }).catch(error => { if (error.code !== 'lease_held') throw error; });
    if (!taken) await delay(100);
  }
  assert.ok(taken, 'the new window could not take control within 5 s of the old window closing');
  assert.equal(taken.leaseEpoch, held + 1);
  await echo(newWindow, first.id, taken.leaseEpoch, 'LEASE_TAKEN_AFTER_CLOSE');
  check(`the old window closing frees its lease at once (${Date.now() - closedAt} ms, epoch ${held} -> ${taken.leaseEpoch}); input works`);
  oldWindow = await connectControl(credential, oldId);
  await rejectsWith(() => oldWindow.request('terminal.input', { sessionId: first.id, data: 'echo STALE\r', leaseEpoch: held }), 'stale_lease');
  check('the departed window is fenced out with stale_lease after it reconnects');

  // 2. The same window reconnecting keeps its lease and epoch.
  let sameId = `same-window-${randomUUID()}`, same = await connectControl(credential, sameId);
  const kept = (await same.request('session.claim', { sessionId: second.id })).leaseEpoch;
  same.close(); await delay(300);
  same = await connectControl(credential, sameId);
  assert.equal((await same.request('session.renew', { sessionId: second.id, leaseEpoch: kept })).leaseEpoch, kept);
  await rejectsWith(() => newWindow.request('session.claim', { sessionId: second.id }), 'lease_held');
  check('a window that reconnects keeps its lease and epoch; others still get lease_held');

  // 3. Runtime restart: leases of the previous runtime's clients stop blocking new ones; a returning client keeps its own.
  // Stopping a terminal keeps its lease row; stop them so the shutdown does not wait on live shells.
  for (const session of [first, second]) await newWindow.request('session.stop', { sessionId: session.id, operationId: randomUUID() });
  await stopRuntime(newWindow);
  credential = await startRuntime();
  const restarted = await connectControl(credential, `restarted-window-${randomUUID()}`);
  const adopted = await restarted.request('session.claim', { sessionId: first.id });
  assert.equal(adopted.leaseEpoch, taken.leaseEpoch + 1);
  same = await connectControl(credential, sameId);
  assert.equal((await same.request('session.claim', { sessionId: second.id })).leaseEpoch, kept);
  await rejectsWith(() => restarted.request('session.claim', { sessionId: second.id }), 'lease_held');
  check('after a runtime restart a new window takes the old lease at once; a returning window keeps its epoch');

  await stopRuntime(restarted);
  const report = { passed: true, checks };
  await mkdir(join(root, 'qa/results/lease-restart-runtime'), { recursive: true });
  await writeFile(join(root, 'qa/results/lease-restart-runtime/report.json'), JSON.stringify(report, null, 2));
  console.log('LEASE RESTART QA PASSED');
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
  assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}threadterm-lease-restart-`), `Refusing cleanup outside scratch: ${target}`);
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
