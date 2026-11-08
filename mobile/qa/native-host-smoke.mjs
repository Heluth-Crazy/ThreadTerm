import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHmac, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  PROTOCOL_CONTRACT,
  PROTOCOL_VERSION,
  validateResult,
} from '../../protocol/index.ts';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const START_TIMEOUT_MS = 20_000;
const STEP_TIMEOUT_MS = 90_000;
const POLL_MS = 50;

const delay = milliseconds =>
  new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));

function boundedText(current, chunk) {
  const next = current + chunk.toString('utf8');
  return next.length <= MAX_DIAGNOSTIC_BYTES
    ? next
    : next.slice(next.length - MAX_DIAGNOSTIC_BYTES);
}

function collectOutput(stream) {
  let output = '';
  stream?.on('data', chunk => {
    output = boundedText(output, chunk);
  });
  return () => output;
}

function waitForExit(child, timeoutMs, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({code: child.exitCode, signal: child.signalCode});
  }
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectExit(new Error(`${label} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolveExit({code, signal});
    };
    const onError = error => {
      cleanup();
      rejectExit(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function stopOwnedProcess(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  try {
    await waitForExit(child, 5_000, label);
  } catch {
    child.kill('SIGKILL');
    await waitForExit(child, 5_000, label).catch(() => {});
  }
}

class LocalPeer {
  constructor(socket) {
    this.socket = socket;
    this.queue = [];
    this.waiters = [];
    this.pending = Buffer.alloc(0);
    this.closed = false;
    this.failure = null;
    socket.on('data', bytes => this.accept(bytes));
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('local runtime pipe closed')));
  }

  accept(bytes) {
    this.pending = Buffer.concat([this.pending, bytes]);
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        this.fail(new Error(`oversized local runtime frame: ${length}`));
        this.socket.destroy();
        return;
      }
      if (this.pending.length < length + 4) return;
      const frame = this.pending.subarray(4, length + 4);
      this.pending = this.pending.subarray(length + 4);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(frame);
      else this.queue.push(frame);
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(timeoutMs = 10_000) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(this.failure ?? new Error('closed'));
    return new Promise((resolveFrame, rejectFrame) => {
      let timeout;
      const waiter = {
        resolve: frame => {
          clearTimeout(timeout);
          resolveFrame(frame);
        },
        reject: error => {
          clearTimeout(timeout);
          rejectFrame(error);
        },
      };
      timeout = setTimeout(() => {
        this.waiters = this.waiters.filter(candidate => candidate !== waiter);
        rejectFrame(new Error(`local runtime frame timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  sendJson(value) {
    const body = Buffer.from(JSON.stringify(value));
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    this.socket.write(frame);
  }

  async authenticate(credential) {
    const challenge = JSON.parse((await this.next()).toString('utf8'));
    assert.equal(challenge.kind, 'challenge');
    assert.equal(challenge.protocol, PROTOCOL_VERSION);
    assert.equal(challenge.contract, PROTOCOL_CONTRACT);
    const clientId = randomUUID();
    this.sendJson({
      kind: 'auth',
      clientId,
      protocol: PROTOCOL_VERSION,
      contract: PROTOCOL_CONTRACT,
      nonce: challenge.nonce,
      hmac: createHmac('sha256', credential)
        .update(`${PROTOCOL_VERSION}:${clientId}:${challenge.nonce}`)
        .digest('hex'),
    });
    const proof = JSON.parse((await this.next()).toString('utf8'));
    assert.equal(proof.kind, 'authenticated');
    assert.equal(proof.contract, PROTOCOL_CONTRACT);
    assert.equal(
      proof.hmac,
      createHmac('sha256', credential)
        .update(`server:${PROTOCOL_VERSION}:${clientId}:${challenge.nonce}`)
        .digest('hex'),
      'runtime server proof',
    );
  }

  async request(method, params = {}) {
    const id = randomUUID();
    this.sendJson({v: 1, id, method, params});
    for (;;) {
      const frame = JSON.parse((await this.next(15_000)).toString('utf8'));
      if (frame.id !== id) continue;
      if (frame.error) {
        throw Object.assign(new Error(frame.error.message), {
          code: frame.error.code,
          details: frame.error.details,
        });
      }
      validateResult(method, frame.result);
      return frame.result;
    }
  }

  close() {
    this.socket.destroy();
  }
}

async function connectPipe(pipeName) {
  const socket = await new Promise((resolveSocket, rejectSocket) => {
    const candidate = net.createConnection(pipeName);
    candidate.once('connect', () => resolveSocket(candidate));
    candidate.once('error', rejectSocket);
  });
  return new LocalPeer(socket);
}

async function connectRuntime({dataDir, daemon, daemonError, pipeBase}) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) {
      throw new Error(
        `runtime exited before IPC became ready (${daemon.exitCode ?? daemon.signalCode})\n${daemonError()}`,
      );
    }
    try {
      const credential = (await readFile(join(dataDir, 'runtime.credential'), 'utf8')).trim();
      assert.match(credential, /^[0-9a-f]{64}$/u);
      const peer = await connectPipe(`${pipeBase}-control`);
      try {
        await peer.authenticate(credential);
        return peer;
      } catch (error) {
        peer.close();
        throw error;
      }
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`runtime IPC did not become ready: ${lastError?.message ?? 'timeout'}`);
}

async function waitForMarker(path, expected, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await readFile(path, 'utf8');
      assert.equal(value, expected);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `native smoke exited before ${expected.trim()} (${child.exitCode ?? child.signalCode})`,
      );
    }
    await delay(POLL_MS);
  }
  throw new Error(`timed out waiting for native marker ${expected.trim()}`);
}

async function waitForMobileDevice(controller, deviceName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const devices = await controller.request('device.list');
    const matches = devices.filter(
      device => device.profile === 'mobile' && device.name === deviceName,
    );
    if (matches.length > 1) {
      throw new Error(`multiple mobile devices matched the unique smoke name`);
    }
    if (matches[0]?.connected === true) return matches[0];
    await delay(100);
  }
  throw new Error('paired mobile did not appear as a connected device');
}

async function waitFor(check, label, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_MS);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function isolatedEnvironment({dataDir, pipeBase, scratch, fixtureBin, chatLog}) {
  const removed = new Set([
    'path',
    'temp',
    'tmp',
    'home',
    'userprofile',
    'codex_home',
    'threadterm_v3_data',
    'threadterm_v3_user_data',
    'threadterm_v3_pipe',
    'threadterm_qa_remote_bind',
  ]);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !removed.has(key.toLowerCase())),
  );
  Object.assign(environment, {
    PATH: [fixtureBin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    TEMP: scratch,
    TMP: scratch,
    HOME: join(scratch, 'home'),
    USERPROFILE: join(scratch, 'home'),
    CODEX_HOME: join(scratch, 'home', '.codex'),
    THREADTERM_V3_DATA: dataDir,
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: pipeBase,
    THREADTERM_QA_REMOTE_BIND: '127.0.0.1',
    THREADTERM_QA_MOBILE_CHAT_LOG: chatLog,
    // Debug runtime discovery deliberately ignores ambient PATH for built-in
    // CLIs. Keep the fake provider explicit and confined to this smoke run.
    THREADTERM_QA_PROVIDER_BIN: fixtureBin,
  });
  assert.equal(
    Object.keys(environment).filter(key => key.toLowerCase() === 'path').length,
    1,
    'isolated environment has one PATH spelling',
  );
  return environment;
}

async function main() {
  assert.equal(process.platform, 'win32', 'native-host smoke requires Windows named pipes');
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '..', '..');
  const runtimeExecutable = resolve(
    process.env.THREADTERM_QA_RUNTIME_EXE
      ?? process.env.THREADTERM_V3_RUNTIME_BIN
      ?? join(root, 'runtime', 'target-qa', 'debug', 'threadterm-v3-runtime.exe'),
  );
  const nativeExecutable = resolve(
    process.env.THREADTERM_MOBILE_HOST_SMOKE_CLIENT_EXE
      ?? join(
        root,
        'mobile',
        'native-client',
        'target-qa',
        'debug',
        'examples',
        'host_smoke.exe',
      ),
  );
  assert.ok(existsSync(runtimeExecutable), `missing runtime executable: ${runtimeExecutable}`);
  assert.ok(existsSync(nativeExecutable), `missing native smoke executable: ${nativeExecutable}`);

  const scratchBase = resolve(process.env.THREADTERM_QA_SCRATCH ?? tmpdir());
  await mkdir(scratchBase, {recursive: true});
  const scratch = await mkdtemp(join(scratchBase, 'threadterm-native-host-smoke-'));
  assert.equal(resolve(dirname(scratch)), scratchBase, 'scratch remains under its requested root');
  const dataDir = join(scratch, 'data');
  const projectDir = join(scratch, 'terminal-project');
  const fixtureBin = join(scratch, 'bin');
  const chatLog = join(scratch, 'mobile-chat-provider.jsonl');
  const pipeBase = `\\\\.\\pipe\\threadterm-native-host-${randomUUID()}`;
  const deviceName = `Native host smoke ${randomUUID().slice(0, 12)}`;
  await Promise.all([
    mkdir(dataDir),
    mkdir(join(scratch, 'home'), {recursive: true}),
    mkdir(join(scratch, 'profile'), {recursive: true}),
    mkdir(projectDir),
    mkdir(fixtureBin),
  ]);
  const codexFixture = join(root, 'mobile', 'qa', 'fake-codex-mobile-smoke.cjs');
  assert.ok(existsSync(codexFixture), `missing offline mobile Codex fixture: ${codexFixture}`);
  await writeFile(
    join(fixtureBin, 'codex.cmd'),
    `@echo off\r\n@"${process.execPath}" "${codexFixture}" %*\r\n`,
    {encoding: 'utf8', flag: 'wx'},
  );
  await writeFile(chatLog, '', {encoding: 'utf8', flag: 'wx'});
  const environment = isolatedEnvironment({dataDir, pipeBase, scratch, fixtureBin, chatLog});

  let controller;
  let daemon;
  const natives = [];
  let daemonError = () => '';
  const nativeDiagnostics = [];
  const startedAt = Date.now();
  try {
    daemon = spawn(runtimeExecutable, [], {
      cwd: root,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    daemonError = collectOutput(daemon.stderr);
    controller = await connectRuntime({dataDir, daemon, daemonError, pipeBase});

    const status = await controller.request('device.enable', {operationId: randomUUID()});
    assert.equal(status.enabled, true);
    assert.equal(Number.isInteger(status.port), true);
    assert.equal(status.port > 0 && status.port <= 65_535, true);
    assert.match(status.tlsFingerprint, /^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/iu);

    const project = await controller.request('project.add', {path:projectDir,name:'Native terminal smoke',operationId:randomUUID()});
    const terminal = await controller.request('session.create', {projectId:project.id,cwd:projectDir,provider:'shell',mode:'terminal',title:'Native terminal smoke',executable:'cmd.exe',args:['/Q','/K'],operationId:randomUUID()});
    let providers = [];
    try {
      await waitFor(async () => {
        providers = await controller.request('provider.list');
        return providers.some(provider => provider.id === 'codex' && provider.chat);
      }, 'offline Codex provider discovery');
    } catch (error) {
      throw new Error(`${error.message}; last provider.list: ${JSON.stringify(providers)}`);
    }
    const chat = await controller.request('session.create', {projectId:project.id,cwd:projectDir,provider:'codex',mode:'chat',title:'Native chat smoke',operationId:randomUUID()});
    async function runScenario({ permission, terminalSessionId, chatSessionId, name }) {
      const descriptorFile = join(scratch, `pairing-${name}.txt`);
      const readyFile = join(scratch, `native-${name}-ready`);
      const revokedFile = join(scratch, `native-${name}-revoked`);
      const scenarioDeviceName = `${deviceName} ${name}`;
      const offer = await controller.request('device.pairing.create', {permission, profile:'mobile', operationId:randomUUID()});
      assert.match(offer.qrPayload, /^threadterm:\/\/pair\?data=/u);
      const descriptor = JSON.parse(Buffer.from(offer.qrPayload.slice('threadterm://pair?data='.length), 'base64url').toString('utf8'));
      assert.equal(descriptor.v, 1, 'disabled iroh produces the deterministic TCP descriptor');
      assert.equal(descriptor.profile, 'mobile');
      assert.equal(new URL(descriptor.serverUrl).hostname, '127.0.0.1');
      assert.equal(descriptor.iroh, undefined);
      assert.equal(descriptor.tlsFingerprint, status.tlsFingerprint);
      await writeFile(descriptorFile, offer.qrPayload, {encoding:'utf8',flag:'wx',mode:0o600});
      const args=['--descriptor-file',descriptorFile,'--device-name',scenarioDeviceName,'--ready-file',readyFile,'--revoked-file',revokedFile];
      if (terminalSessionId) args.push('--terminal-session-id', terminalSessionId);
      if (chatSessionId) args.push('--chat-session-id', chatSessionId);
      const native = spawn(nativeExecutable,args,{cwd:root,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
      natives.push(native);
      const output=collectOutput(native.stdout), error=collectOutput(native.stderr);
      nativeDiagnostics.push(() => [output(),error()].filter(Boolean).join('\n'));
      await waitForMarker(readyFile,'READY\n',native,STEP_TIMEOUT_MS);
      if (chatSessionId) {
        await waitFor(async () => {
          const lines = (await readFile(chatLog, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
          return lines.some(entry => entry.method === 'turn/start' && entry.text === 'MOBILE_NATIVE_CHAT_SEND');
        }, 'native chat.send reached offline provider');
      }
      const device=await waitForMobileDevice(controller,scenarioDeviceName,10_000);
      assert.equal(device.permission,permission);assert.equal(device.revokedAt,undefined);
      await controller.request('device.revoke',{deviceId:device.id,operationId:randomUUID()});
      await waitForMarker(revokedFile,'REVOKED\n',native,10_000);
      const nativeExit=await waitForExit(native,10_000,`native ${name} smoke`);
      assert.equal(nativeExit.code,0,`native ${name} smoke failed (${nativeExit.signal ?? nativeExit.code})\n${output()}\n${error()}`);
      const afterRevoke=(await controller.request('device.list')).find(candidate=>candidate.id===device.id);
      assert.ok(afterRevoke?.revokedAt,'host persists the mobile revocation');assert.equal(afterRevoke.connected,false);
    }
    await runScenario({permission:'readonly',name:'readonly'});
    await runScenario({permission:'fullcontrol',terminalSessionId:terminal.id,chatSessionId:chat.id,name:'control'});

    await controller.request('runtime.shutdown', {operationId: randomUUID()});
    const daemonExit = await waitForExit(daemon, 10_000, 'isolated runtime');
    assert.equal(
      daemonExit.code,
      0,
      `runtime shutdown failed (${daemonExit.signal ?? daemonExit.code})\n${daemonError()}`,
    );
    console.log(JSON.stringify({
      passed: true,
      elapsedMs: Date.now() - startedAt,
      checks: [
        'isolated runtime local IPC authentication',
        'mobile v1 loopback pairing descriptor',
        'native certificate pin and retained-stream pairing',
        'mobile snapshot validation',
        'readonly mutation denial',
        'full-control native lease, terminal resize, LF refusal, CR input and terminal echo',
        'full-control native chat.send delivered to the isolated offline provider',
        'host device visibility',
        'typed live revocation and closure',
        'durable host revocation',
      ],
    }));
  } catch (error) {
    const nativeDiagnosticText = nativeDiagnostics.map(read => read()).filter(Boolean).join('\n');
    const runtimeDiagnostics = daemonError();
    throw new Error(
      [error?.stack ?? String(error), nativeDiagnosticText, runtimeDiagnostics]
        .filter(Boolean)
        .join('\n'),
    );
  } finally {
    controller?.close();
    await Promise.all(natives.map(native => stopOwnedProcess(native, 'native host smoke')));
    await stopOwnedProcess(daemon, 'isolated runtime');
    assert.equal(resolve(dirname(scratch)), scratchBase, 'cleanup scratch boundary');
    await rm(scratch, {recursive: true, force: true});
  }
}

main().catch(error => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
