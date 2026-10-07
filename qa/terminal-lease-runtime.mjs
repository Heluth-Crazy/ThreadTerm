// Real-runtime regression for an ordinary Windows cmd.exe terminal lease.
// It deliberately crosses the 30 s TTL twice: first with renewals, then without.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { validateResult } from '../protocol/index.ts';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const root = resolve('.');
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE || join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
assert.ok(existsSync(runtime), `Missing isolated QA runtime: ${runtime}`);

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-terminal-lease-'));
const data = join(scratch, 'data');
const project = join(scratch, 'project');
const pipe = `\\\\.\\pipe\\threadterm-terminal-lease-${randomUUID()}`;
const peers = [];
let daemon;
let stderr = '';

class Peer {
  queue = []; waiters = []; pending = Buffer.alloc(0); closed = false;
  constructor(socket) {
    this.socket = socket;
    socket.on('data', bytes => {
      this.pending = Buffer.concat([this.pending, bytes]);
      while (this.pending.length >= 4) {
        const length = this.pending.readUInt32LE();
        if (length > 8_388_608) throw Error('Oversized runtime frame');
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
      const waiter = { resolve: frame => { clearTimeout(timer); resolveNext(frame); }, reject: error => { clearTimeout(timer); rejectNext(error); } };
      const timer = setTimeout(() => { this.waiters = this.waiters.filter(item => item !== waiter); rejectNext(Error('Runtime frame timed out')); }, timeout);
      this.waiters.push(waiter);
    });
  }
  json(value) { const bytes = Buffer.from(JSON.stringify(value)); const frame = Buffer.alloc(bytes.length + 4); frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4); this.socket.write(frame); }
  async auth(credential, clientId) {
    const challenge = JSON.parse(await this.next());
    assert.equal(challenge.contract, 3);
    this.json({ kind: 'auth', clientId, protocol: 1, contract: 3, nonce: challenge.nonce, hmac: createHmac('sha256', credential).update(`1:${clientId}:${challenge.nonce}`).digest('hex') });
    const proof = JSON.parse(await this.next());
    assert.equal(proof.kind, 'authenticated'); assert.equal(proof.contract, 3);
    assert.equal(proof.hmac, createHmac('sha256', credential).update(`server:1:${clientId}:${challenge.nonce}`).digest('hex'));
  }
  async request(method, params = {}) {
    const id = randomUUID(); this.json({ v: 1, id, method, params });
    for (;;) { const message = JSON.parse(await this.next()); if (message.id !== id) continue; if (message.error) throw Object.assign(Error(message.error.message), { code: message.error.code }); validateResult(method, message.result); return message.result; }
  }
  close() { this.socket.destroy(); }
}

async function connectPeer(name) {
  const socket = await new Promise((resolveSocket, rejectSocket) => { const candidate = net.createConnection(name); candidate.once('connect', () => resolveSocket(candidate)); candidate.once('error', rejectSocket); });
  return new Peer(socket);
}

async function connectControl(credential, clientId) {
  const peer = await connectPeer(`${pipe}-control`);
  await peer.auth(credential, clientId);
  peers.push(peer);
  return peer;
}

async function waitForRuntime() {
  let lastError;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const credential = (await readFile(join(data, 'runtime.credential'), 'utf8')).trim();
      const probe = await connectControl(credential, 'terminal-lease-probe');
      probe.close();
      return credential;
    } catch (error) {
      lastError = error;
      if (daemon.exitCode !== null) throw Error(`Runtime exited during startup (${daemon.exitCode}): ${stderr}`);
      await delay(100);
    }
  }
  throw Error(`Runtime startup timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForOutput(peer, sessionId, marker, startCursor = 0) {
  let cursor = startCursor;
  let output = '';
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const page = await peer.request('terminal.read', { sessionId, cursor, limit: 65_536 });
    assert.equal(page.fromCursor, cursor, 'terminal history must be contiguous');
    if (page.nextCursor > cursor) {
      output += Buffer.from(page.data, 'base64').toString('utf8');
      cursor = page.nextCursor;
      if (output.includes(marker)) return cursor;
    }
    await delay(80);
  }
  throw Error(`Did not observe ${marker} in cmd output`);
}

async function expectLeaseError(action, expectedCode) {
  await assert.rejects(action, error => error?.code === expectedCode);
}

try {
  await mkdir(data); await mkdir(project);
  daemon = spawn(runtime, [], {
    env: { ...process.env, THREADTERM_V3_DATA: data, THREADTERM_V3_PIPE: pipe },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  daemon.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });

  const credential = await waitForRuntime();
  const controller = await connectControl(credential, 'terminal-lease-controller');
  const contender = await connectControl(credential, 'terminal-lease-contender');
  const projectRow = await controller.request('project.add', { path: project, name: 'Terminal lease runtime QA', operationId: randomUUID() });
  const session = await controller.request('session.create', {
    projectId: projectRow.id,
    cwd: project,
    title: 'Lease runtime cmd',
    provider: 'shell',
    mode: 'terminal',
    executable: 'cmd.exe',
    args: ['/Q', '/K'],
    operationId: randomUUID(),
  });

  const first = await controller.request('session.claim', { sessionId: session.id });
  let cursor = 0;
  const beforeMarker = 'LEASE_RENEWED_CMD_OK';
  await controller.request('terminal.input', { sessionId: session.id, data: `echo ${beforeMarker}\r`, leaseEpoch: first.leaseEpoch });
  cursor = await waitForOutput(controller, session.id, beforeMarker, cursor);
  await expectLeaseError(
    () => contender.request('session.claim', { sessionId: session.id }),
    'lease_held',
  );

  // Four renewals span more than one TTL. The ordinary cmd.exe process must stay usable.
  for (let renewal = 0; renewal < 4; renewal += 1) {
    await delay(8_000);
    const result = await controller.request('session.renew', { sessionId: session.id, leaseEpoch: first.leaseEpoch });
    assert.equal(result.leaseEpoch, first.leaseEpoch, 'renewal preserves the current epoch');
  }
  const afterRenewMarker = 'LEASE_AFTER_32_SECONDS_OK';
  await controller.request('terminal.input', { sessionId: session.id, data: `echo ${afterRenewMarker}\r`, leaseEpoch: first.leaseEpoch });
  cursor = await waitForOutput(controller, session.id, afterRenewMarker, cursor);

  // Stop renewing long enough for the runtime lease to expire. The old input token is fenced out.
  await delay(31_000);
  await expectLeaseError(
    () => controller.request('terminal.input', { sessionId: session.id, data: 'echo STALE_INPUT_MUST_NOT_RUN\r', leaseEpoch: first.leaseEpoch }),
    'stale_lease',
  );
  const recovered = await controller.request('session.claim', { sessionId: session.id });
  assert.ok(recovered.leaseEpoch > first.leaseEpoch, 'expired lease must receive a newer epoch');
  const recoveredMarker = 'LEASE_RECLAIMED_CMD_OK';
  await controller.request('terminal.input', { sessionId: session.id, data: `echo ${recoveredMarker}\r`, leaseEpoch: recovered.leaseEpoch });
  cursor = await waitForOutput(controller, session.id, recoveredMarker, cursor);

  await controller.request('session.stop', { sessionId: session.id, operationId: randomUUID() });
  await controller.request('runtime.shutdown', { operationId: randomUUID() });
  if (daemon.exitCode === null) await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(Error('Runtime did not exit after confirmed shutdown')), 10_000);
    daemon.once('exit', () => { clearTimeout(timer); resolveExit(); });
  });
  assert.equal(daemon.exitCode, 0);

  const report = {
    passed: true,
    checks: [
      'real cmd input before lease horizon',
      'four renewals across 32 seconds',
      'distinct authenticated client receives lease_held',
      'expired epoch rejects terminal input as stale_lease',
      'fresh claim receives a newer epoch and restores cmd input',
    ],
  };
  await mkdir('qa/results/terminal-lease-runtime', { recursive: true });
  await writeFile('qa/results/terminal-lease-runtime/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
} finally {
  for (const peer of peers) peer.close();
  if (daemon?.exitCode === null) {
    const exited = new Promise(resolveExit => daemon.once('exit', resolveExit));
    daemon.kill();
    await Promise.race([exited, delay(5_000)]);
  }
  const cleanupTarget = resolve(scratch), cleanupBase = resolve(tmpdir());
  assert.ok(cleanupTarget.startsWith(`${cleanupBase}${sep}threadterm-terminal-lease-`), `Refusing cleanup outside owned scratch: ${cleanupTarget}`);
  await rm(cleanupTarget, { recursive: true, force: true });
}
