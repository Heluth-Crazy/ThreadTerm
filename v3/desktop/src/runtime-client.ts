import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { platform, env } from 'node:process';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { app } from 'electron';
import {
  MAX_FRAME_BYTES,
  PROTOCOL_CONTRACT,
  PROTOCOL_VERSION,
  isRecord,
  isRuntimeEvent,
  protocolIncompatibleReason,
  validateResult,
  type Method,
  type OutputChunk,
  type RequestParams,
  type RequestResult,
  type RuntimeError,
  type RuntimeEvent,
} from '@threadterm/protocol';
import { OutputFanout } from './output-fanout.js';

const CONNECT_TIMEOUT_MS = 1_500;
const RUNTIME_READY_TIMEOUT_MS = 12_000;
const RETRY_DELAY_MS = 400;
const INITIAL_OUTPUT_CREDIT = 64 * 1024;
const MAX_OUTPUT_CREDIT = 8 * 1024 * 1024;

interface ControlRequest { v: 1; id: string; method: string; params: Record<string, unknown> }
interface ControlResponse { v: 1; id: string; result?: unknown; error?: RuntimeError }
interface AuthChallenge { kind: 'challenge'; nonce: string; protocol: number; contract?: number }
interface AuthRequest { kind: 'auth'; clientId: string; protocol: number; contract: number; nonce: string; hmac: string }
interface Authenticated { kind: 'authenticated'; principal: string; epoch: string; hmac: string; contract?: number }
interface PendingRequest { method: Method; resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
interface OutputSubscription { id: string; sessionId: string; cursor: number; onChunk: (chunk: OutputChunk) => void | Promise<void> }
interface OutputGroup { sessionId: string; cursor: number; fanout: OutputFanout; delivery: Promise<void> }

const OUTPUT_BACKFILL_PAGE_BYTES = 64 * 1024;

export class RuntimeUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'RuntimeUnavailableError'; }
}

export class ProtocolIncompatibleError extends Error {
  readonly code = 'protocol_incompatible';
  constructor(message: string) { super(message); this.name = 'ProtocolIncompatibleError'; }
}

/** A typed runtime command failure retained inside the Electron main client. */
export class RuntimeRequestError extends Error {
  readonly code: string;
  constructor(error: RuntimeError) { super(error.message); this.name = 'RuntimeRequestError'; this.code = error.code; }
}

class LengthPrefixedSocket {
  readonly socket: net.Socket;
  private incoming = Buffer.alloc(0);
  private readonly frames = new Set<(frame: Buffer) => void>();
  private readonly failures = new Set<(error: Error) => void>();

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.consume(chunk));
    socket.on('error', (error: Error) => this.fail(error));
    socket.on('close', () => this.fail(new RuntimeUnavailableError('Runtime pipe closed')));
  }

  static connect(pipe: string): Promise<LengthPrefixedSocket> {
    return new Promise((resolvePromise, reject) => {
      const socket = net.createConnection(pipe);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new RuntimeUnavailableError('Timed out connecting to the runtime'));
      }, CONNECT_TIMEOUT_MS);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolvePromise(new LengthPrefixedSocket(socket));
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(new RuntimeUnavailableError(`Could not connect to the runtime: ${error.message}`));
      });
    });
  }

  onFrame(listener: (frame: Buffer) => void): () => void { this.frames.add(listener); return () => this.frames.delete(listener); }
  onFailure(listener: (error: Error) => void): () => void { this.failures.add(listener); return () => this.failures.delete(listener); }
  close(): void { this.socket.destroy(); }

  write(payload: Buffer): void {
    if (payload.length > MAX_FRAME_BYTES) throw new Error('Frame exceeds the protocol limit');
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    this.socket.write(frame);
  }

  private consume(chunk: Buffer): void {
    this.incoming = Buffer.concat([this.incoming, chunk]);
    while (this.incoming.length >= 4) {
      const length = this.incoming.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) { this.fail(new Error('Runtime sent an oversized frame')); this.close(); return; }
      if (this.incoming.length < 4 + length) return;
      const frame = this.incoming.subarray(4, 4 + length);
      this.incoming = this.incoming.subarray(4 + length);
      for (const listener of this.frames) listener(frame);
    }
  }

  private fail(error: Error): void { for (const listener of this.failures) listener(error); }
}

export async function runtimePipeIsOpen(): Promise<boolean> {
  const pipes = await runtimePipes();
  try {
    const connection = await LengthPrefixedSocket.connect(pipes.control);
    connection.close();
    return true;
  } catch { return false; }
}

export class RuntimeClient {
  constructor(private readonly options: { autoLaunch?: boolean } = {}) {}
  private control?: LengthPrefixedSocket;
  private output?: LengthPrefixedSocket;
  private readonly clientId = randomUUID();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: RuntimeEvent) => void>();
  private readonly subscriptions = new Map<string, OutputSubscription>();
  private readonly outputGroups = new Map<string, OutputGroup>();
  private connecting?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private expectedDisconnect = false;
  private suspended = false;
  private disconnecting = false;
  private runtimeEpoch = '';
  private sawDisconnect = false;
  private incompatible?: ProtocolIncompatibleError;

  async request<M extends Method>(method: M, params: RequestParams<M>): Promise<RequestResult<M>> {
    await this.ensureConnected();
    this.assertOpen();
    const id = randomUUID();
    const message: ControlRequest = { v: PROTOCOL_VERSION, id, method, params: params as Record<string, unknown> };
    return new Promise<RequestResult<M>>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RuntimeUnavailableError(`Runtime request ${method} timed out`));
      }, 30_000);
      this.pending.set(id, { method, resolve: resolvePromise as (value: unknown) => void, reject, timer });
      try { this.control?.write(Buffer.from(JSON.stringify(message), 'utf8')); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(asError(error)); }
    });
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }

  async subscribeOutput(sessionId: string, cursor: number, onChunk: (chunk: OutputChunk) => void | Promise<void>): Promise<() => void> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid output cursor');
    await this.ensureConnected();
    this.assertOpen();
    const id = randomUUID();
    const subscription: OutputSubscription = { id, sessionId, cursor, onChunk };
    let group = this.outputGroups.get(sessionId);
    const isNewGroup = !group;
    if (!group) { group = { sessionId, cursor, fanout: new OutputFanout(), delivery: Promise.resolve() }; this.outputGroups.set(sessionId, group); }
    this.subscriptions.set(id, subscription);
    // A group has one upstream cursor.  A view which joins it later must not
    // rewind that cursor (which would duplicate bytes for every existing view),
    // but it still needs the history it explicitly requested.  Gate live bytes
    // for this consumer while the control pipe reads the bounded missing range.
    // That gate also preserves byte order if a live output frame arrives while
    // its backfill request is in flight.
    let active = true;
    let resolveLiveGate!: () => void;
    const liveGate = new Promise<void>((resolvePromise) => { resolveLiveGate = resolvePromise; });
    let deliveredCursor = cursor;
    const deliver = async (chunk: OutputChunk, ceiling = Number.POSITIVE_INFINITY): Promise<void> => {
      if (!active) return;
      if (chunk.gap) {
        if (chunk.cursor > deliveredCursor) {
          await onChunk({ ...chunk, data: new Uint8Array(), cursor: chunk.cursor, gap: true });
          deliveredCursor = chunk.cursor;
        }
        return;
      }
      const start = Math.max(chunk.cursor, deliveredCursor);
      const end = Math.min(chunk.cursor + chunk.data.byteLength, ceiling);
      if (end <= start) return;
      const offset = start - chunk.cursor;
      const data = offset === 0 && end === chunk.cursor + chunk.data.byteLength
        ? chunk.data
        : chunk.data.slice(offset, offset + end - start);
      await onChunk({ sessionId, cursor: start, data });
      deliveredCursor = end;
    };
    const removeConsumer = group.fanout.add(id, async (chunk) => {
      await liveGate;
      await deliver(chunk);
    });
    const cleanup = () => {
      active = false;
      resolveLiveGate();
      removeConsumer();
      this.subscriptions.delete(id);
      if (group!.fanout.size !== 0) return;
      if (this.output) { try { this.sendOutputFrame(5, { sessionId }); } catch { /* disconnect path owns cleanup */ } }
      group!.fanout.dispose();
      if (this.outputGroups.get(sessionId) === group) this.outputGroups.delete(sessionId);
    };
    try {
      if (isNewGroup) {
        this.sendOutputFrame(3, { sessionId, cursor });
        this.sendOutputFrame(2, { sessionId, credit: INITIAL_OUTPUT_CREDIT });
      } else {
        const end = group.cursor;
        await this.backfillConsumer(sessionId, cursor, end, deliver);
      }
      resolveLiveGate();
    } catch (error) { cleanup(); throw error; }
    return cleanup;
  }

  private async backfillConsumer(
    sessionId: string,
    cursor: number,
    end: number,
    deliver: (chunk: OutputChunk, ceiling?: number) => Promise<void>,
  ): Promise<void> {
    let next = cursor;
    while (next < end) {
      const requestedCursor = next;
      const page = await this.request('terminal.read', { sessionId, cursor: next, limit: OUTPUT_BACKFILL_PAGE_BYTES });
      if (page.fromCursor > next) {
        // The read may observe newer output after the snapshot.  Do not move
        // this consumer beyond its captured boundary or it would trim those
        // newer live bytes when the gate opens.
        await deliver({ sessionId, cursor: Math.min(page.fromCursor, end), data: new Uint8Array(), gap: true }, end);
      }
      // A read which starts at or beyond the captured boundary has fully
      // accounted for this consumer's requested range.  It is valid for that
      // page to be gap-only and report no advancing nextCursor.
      if (page.fromCursor >= end) return;
      const data = Buffer.from(page.data, 'base64');
      await deliver({ sessionId, cursor: page.fromCursor, data }, end);
      // A page that neither advances the logical cursor nor reaches the
      // captured watermark cannot be retried safely: it would leave this
      // consumer permanently blocking shared-stream credits.
      if (page.nextCursor <= requestedCursor) throw new RuntimeUnavailableError('Runtime output history did not advance');
      next = page.nextCursor;
    }
  }

  dispose(): void {
    this.expectedDisconnect = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.control?.close();
    this.output?.close();
    this.control = undefined;
    this.output = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RuntimeUnavailableError('Desktop is closing')); }
    this.pending.clear();
  }

  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (!suspended && !this.expectedDisconnect) {
      void this.ensureConnected().catch(error => this.handleDisconnect(asError(error)));
    }
  }

  private async ensureConnected(): Promise<void> {
    this.assertOpen();
    if (this.incompatible) throw this.incompatible;
    if (this.control && this.output) return;
    if (!this.connecting) this.connecting = this.connectAndAuthenticate().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async connectAndAuthenticate(): Promise<void> {
    const pipes = await runtimePipes();
    this.assertOpen();
    if (!readCredential()) {
      if (this.options.autoLaunch === false) throw new RuntimeUnavailableError('Runtime is not running');
      await launchRuntimeIfNeeded();
    }
    this.assertOpen();
    const token = await waitForCredential();
    this.assertOpen();
    let control: LengthPrefixedSocket;
    try { control = await connectUntilReady(pipes.control, CONNECT_TIMEOUT_MS); }
    catch {
      this.assertOpen();
      if (this.options.autoLaunch === false) throw new RuntimeUnavailableError('Runtime is not running');
      await launchRuntimeIfNeeded();
      this.assertOpen();
      control = await connectUntilReady(pipes.control, RUNTIME_READY_TIMEOUT_MS);
    }
    try {
      this.assertOpen();
      const session = await authenticate(control, token, this.clientId);
      this.assertOpen();
      this.attachControl(control);
      const output = await connectUntilReady(pipes.output, RUNTIME_READY_TIMEOUT_MS);
      try { this.assertOpen(); await authenticate(output, token, this.clientId); this.assertOpen(); this.attachOutput(output); }
      catch (error) { output.close(); throw error; }
      const previousEpoch = this.runtimeEpoch;
      this.runtimeEpoch = session.epoch;
      if (this.sawDisconnect) {
        this.sawDisconnect = false;
        this.emitSynthetic('runtime.transport', {
          state: 'reconnected',
          epoch: session.epoch,
          epochChanged: Boolean(previousEpoch) && previousEpoch !== session.epoch,
        });
      }
    } catch (error) {
      control.close();
      if (error instanceof ProtocolIncompatibleError) this.incompatible = error;
      throw error;
    }
  }

  private attachControl(control: LengthPrefixedSocket): void {
    this.control = control;
    control.onFrame((frame) => this.handleControlFrame(frame));
    control.onFailure((error) => this.handleDisconnect(error));
  }

  private attachOutput(output: LengthPrefixedSocket): void {
    this.output = output;
    output.onFrame((frame) => {
      void this.handleOutputFrame(frame, output).catch((error) => this.handleDisconnect(asError(error)));
    });
    output.onFailure((error) => this.handleDisconnect(error));
    for (const group of this.outputGroups.values()) {
      this.sendOutputFrame(3, { sessionId: group.sessionId, cursor: group.cursor });
      this.sendOutputFrame(2, { sessionId: group.sessionId, credit: INITIAL_OUTPUT_CREDIT });
    }
  }

  private handleControlFrame(frame: Buffer): void {
    let value: unknown;
    try { value = JSON.parse(frame.toString('utf8')) as unknown; } catch { this.handleDisconnect(new Error('Runtime sent invalid JSON')); return; }
    if (isRuntimeEvent(value)) { for (const listener of this.eventListeners) listener(value); return; }
    if (!isControlResponse(value)) { this.handleDisconnect(new Error('Runtime sent an invalid control response')); return; }
    const pending = this.pending.get(value.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(value.id);
    if (value.error) pending.reject(new RuntimeRequestError(value.error));
    else {
      try {
        validateResult(pending.method, value.result);
        if (pending.method === 'runtime.shutdown') this.control?.write(Buffer.from(JSON.stringify({ kind: 'shutdownAck', id: value.id }), 'utf8'));
        pending.resolve(value.result);
      }
      catch (error) { pending.reject(asError(error)); }
    }
  }

  private async handleOutputFrame(frame: Buffer, origin = this.output): Promise<void> {
    if (frame.length < 5) { this.handleDisconnect(new Error('Runtime sent a malformed output frame')); return; }
    const kind = frame.readUInt8(0);
    const headerLength = frame.readUInt32LE(1);
    if (headerLength > MAX_FRAME_BYTES || 5 + headerLength > frame.length) { this.handleDisconnect(new Error('Runtime sent a malformed output header')); return; }
    let header: unknown;
    try { header = JSON.parse(frame.subarray(5, 5 + headerLength).toString('utf8')) as unknown; } catch { this.handleDisconnect(new Error('Runtime sent invalid output metadata')); return; }
    if (!isOutputHeader(header)) { this.handleDisconnect(new Error('Runtime sent invalid output metadata')); return; }
    const data = new Uint8Array(frame.subarray(5 + headerLength));
    const group = this.outputGroups.get(header.sessionId);
    if (!group) return;
    if (kind === 4) {
      const cursor = header.cursor ?? group.cursor;
      // A runtime gap explicitly skips unavailable durable bytes.  Advance the
      // shared watermark before fanout so a later consumer or reconnect never
      // resubscribes from the lost prefix.
      group.cursor = Math.max(group.cursor, cursor);
      await this.queueOutput(group, { sessionId: header.sessionId, cursor, data, gap: true }, 0, origin);
    }
    else if (kind === 1) {
      const cursor = header.cursor ?? group.cursor;
      group.cursor = cursor + data.byteLength;
      await this.queueOutput(group, { sessionId: header.sessionId, cursor, data }, Math.min(data.byteLength, MAX_OUTPUT_CREDIT), origin);
    }
  }

  private assertOpen(): void {
    if (this.expectedDisconnect) throw new RuntimeUnavailableError('Desktop is closing');
    if (this.suspended) throw new RuntimeUnavailableError('Desktop shutdown is in progress');
  }

  private queueOutput(group: OutputGroup, chunk: OutputChunk, credit = 0, origin?: LengthPrefixedSocket): Promise<void> {
    const delivery = group.delivery.then(async () => {
      await group.fanout.publish(chunk);
      // A delayed consumer may finish after this session was unsubscribed or
      // after the output pipe reconnected.  Credit belongs to the transport
      // which supplied this exact frame; never pay it into a newer stream.
      if (credit > 0 && !this.expectedDisconnect && this.output === origin && this.outputGroups.get(group.sessionId) === group) {
        this.sendOutputFrame(2, { sessionId: group.sessionId, credit });
      }
    });
    // Keep later frames ordered even if this transport is about to fail.  The
    // originating call still receives the failure, and the normal reconnect
    // path owns recovery of the group cursor.
    group.delivery = delivery.catch((error) => { this.handleDisconnect(asError(error)); });
    return delivery;
  }

  private sendOutputFrame(kind: number, header: Record<string, unknown>): void {
    if (!this.output) throw new RuntimeUnavailableError('Output pipe is unavailable');
    const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8');
    const payload = Buffer.allocUnsafe(5 + encodedHeader.length);
    payload.writeUInt8(kind, 0); payload.writeUInt32LE(encodedHeader.length, 1); encodedHeader.copy(payload, 5);
    this.output.write(payload);
  }

  private handleDisconnect(error: Error): void {
    if (this.expectedDisconnect || this.disconnecting) return;
    this.disconnecting = true;
    const control = this.control;
    const output = this.output;
    this.control = undefined;
    this.output = undefined;
    control?.close();
    output?.close();
    this.disconnecting = false;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.sawDisconnect = true;
    this.emitSynthetic('runtime.transport', { state: 'disconnected', epoch: this.runtimeEpoch, reason: error.message });
    if (this.incompatible || this.suspended) return;
    if (!this.reconnectTimer) this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensureConnected().catch((caught) => {
        if (caught instanceof ProtocolIncompatibleError) {
          this.incompatible = caught;
          this.emitSynthetic('runtime.transport', { state: 'incompatible', message: caught.message });
          return;
        }
        this.handleDisconnect(new RuntimeUnavailableError('Runtime reconnect failed'));
      });
    }, RETRY_DELAY_MS);
  }

  private emitSynthetic(event: string, data: Record<string, unknown>): void {
    const payload: RuntimeEvent = { v: 1, event, epoch: this.runtimeEpoch || '', seq: 0, data };
    for (const listener of this.eventListeners) listener(payload);
  }
}

let sidHash: Promise<string> | undefined;

async function runtimePipes(): Promise<{ control: string; output: string }> {
  const configured = env.THREADTERM_V3_PIPE;
  if (configured && !configured.startsWith('\\\\.\\pipe\\')) throw new RuntimeUnavailableError('THREADTERM_V3_PIPE must be a Windows named-pipe path');
  const base = configured || `\\\\.\\pipe\\threadterm-v3-${await currentUserSidHash()}`;
  return { control: `${base}-control`, output: `${base}-output` };
}

function currentUserSidHash(): Promise<string> {
  sidHash ??= new Promise<string>((resolvePromise, reject) => {
    if (platform !== 'win32') {
      reject(new RuntimeUnavailableError('A default V3 runtime pipe requires a Windows SID'));
      return;
    }
    execFile('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: CONNECT_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        reject(new RuntimeUnavailableError(`Could not determine the current Windows SID: ${error.message}`));
        return;
      }
      const sid = String(stdout).match(/S-1-(?:\d+-)+\d+/i)?.[0];
      if (!sid) {
        reject(new RuntimeUnavailableError('Could not determine the current Windows SID'));
        return;
      }
      resolvePromise(createHash('sha256').update(sid).digest('hex').slice(0, 16));
    });
  });
  return sidHash;
}

function v3DataDirectory(): string {
  if (env.THREADTERM_V3_DATA) return env.THREADTERM_V3_DATA;
  try { const value = JSON.parse(readFileSync(join(app.getPath('userData'), 'runtime-data-root.json'), 'utf8')) as unknown; if (isRecord(value) && typeof value.root === 'string' && value.root) return value.root; } catch {}
  return join(env.LOCALAPPDATA || env.APPDATA || app.getPath('appData'), 'ThreadTermV3');
}
function credentialPath(): string { return join(v3DataDirectory(), 'runtime.credential'); }
function readCredential(): string | undefined { try { const value = readFileSync(credentialPath(), 'utf8').trim(); return value || undefined; } catch { return undefined; } }
async function waitForCredential(): Promise<string> {
  const deadline = Date.now() + RUNTIME_READY_TIMEOUT_MS;
  while (Date.now() < deadline) { const credential = readCredential(); if (credential) return credential; await delay(RETRY_DELAY_MS); }
  throw new RuntimeUnavailableError('Runtime did not create its bootstrap credential');
}
async function connectUntilReady(pipe: string, timeout: number): Promise<LengthPrefixedSocket> {
  const deadline = Date.now() + timeout;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try { return await LengthPrefixedSocket.connect(pipe); }
    catch (error) { lastError = asError(error); await delay(RETRY_DELAY_MS); }
  }
  throw lastError ?? new RuntimeUnavailableError('Runtime pipe was not ready');
}
async function authenticate(connection: LengthPrefixedSocket, token: string, clientId: string): Promise<{ epoch: string }> {
  return new Promise((resolvePromise, reject) => {
    let nonce = '';
    const timeout = setTimeout(() => { cleanup(); reject(new RuntimeUnavailableError('Runtime authentication timed out')); }, CONNECT_TIMEOUT_MS);
    const cleanup = () => { clearTimeout(timeout); removeFrame(); removeFailure(); };
    const removeFrame = connection.onFrame((frame) => {
      try {
        const value = JSON.parse(frame.toString('utf8')) as unknown;
        if (isAuthChallenge(value)) {
          const reason = protocolIncompatibleReason(value, 'desktop');
          if (reason) throw new ProtocolIncompatibleError(reason);
          nonce = value.nonce;
          const hmac = createHmac('sha256', token).update(`${value.protocol}:${clientId}:${value.nonce}`).digest('hex');
          connection.write(Buffer.from(JSON.stringify({ kind: 'auth', clientId, protocol: PROTOCOL_VERSION, contract: PROTOCOL_CONTRACT, nonce: value.nonce, hmac } satisfies AuthRequest), 'utf8'));
          return;
        }
        if (isRecord(value) && value.kind === 'incompatible') {
          throw new ProtocolIncompatibleError(typeof value.message === 'string' ? value.message : protocolIncompatibleReason(value, 'desktop') || 'Runtime protocol is incompatible');
        }
        const proof = createHmac('sha256', token).update(`server:${PROTOCOL_VERSION}:${clientId}:${nonce}`).digest('hex');
        if (!isAuthenticated(value) || value.principal !== clientId || !sameProof(value.hmac, proof)) throw new Error('Runtime server proof did not verify');
        const replyReason = protocolIncompatibleReason({ protocol: PROTOCOL_VERSION, contract: value.contract }, 'desktop');
        if (replyReason) throw new ProtocolIncompatibleError(replyReason);
        cleanup();
        resolvePromise({ epoch: value.epoch });
      } catch (error) { cleanup(); reject(asError(error)); }
    });
    const removeFailure = connection.onFailure((error) => { cleanup(); reject(error); });
  });
}
async function launchRuntimeIfNeeded(): Promise<void> {
  const { spawn } = await import('node:child_process');
  const { openSync } = await import('node:fs');
  const executable = resolveRuntimeExecutable();
  const runtimeEnv: NodeJS.ProcessEnv = { ...env, THREADTERM_V3_DATA: v3DataDirectory() };
  if (env.THREADTERM_CLAUDE_NODE) {
    delete runtimeEnv.THREADTERM_CLAUDE_ELECTRON_NODE;
  } else {
    runtimeEnv.THREADTERM_CLAUDE_NODE = process.execPath;
    runtimeEnv.THREADTERM_CLAUDE_ELECTRON_NODE = '1';
  }
  // The runtime is otherwise a silent detached daemon; keep its stderr on file
  // so projection and bind failures stay diagnosable after the fact.
  const logPath = join(v3DataDirectory(), 'runtime.log');
  const log = openSync(logPath, 'a');
  const child = executable.kind === 'cargo'
    ? spawn('cargo', ['run', '--manifest-path', executable.path, '--bin', 'threadterm-v3-runtime'], { cwd: resolve(app.getAppPath(), '..'), detached: true, stdio: ['ignore', log, log], windowsHide: true, env: runtimeEnv })
    : spawn(executable.path, [], { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: runtimeEnv });
  child.unref();
}
function resolveRuntimeExecutable(): { kind: 'exe' | 'cargo'; path: string } {
  const configured = env.THREADTERM_V3_RUNTIME;
  if (configured) { if (!existsSync(configured)) throw new RuntimeUnavailableError('THREADTERM_V3_RUNTIME does not exist'); return { kind: 'exe', path: configured }; }
  if (app.isPackaged) return { kind: 'exe', path: join(process.resourcesPath, 'runtime', 'threadterm-v3-runtime.exe') };
  const manifest = resolve(app.getAppPath(), 'runtime', 'Cargo.toml');
  if (!existsSync(manifest)) throw new RuntimeUnavailableError('Runtime Cargo manifest is missing');
  return { kind: 'cargo', path: manifest };
}
function delay(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
function isControlResponse(value: unknown): value is ControlResponse { return isRecord(value) && value.v === 1 && typeof value.id === 'string' && (('result' in value) !== ('error' in value)) && (!('error' in value) || isRuntimeError(value.error)); }
function isRuntimeError(value: unknown): value is RuntimeError { return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string'; }
function isOutputHeader(value: unknown): value is { sessionId: string; cursor?: number } { return isRecord(value) && typeof value.sessionId === 'string' && (value.cursor === undefined || (Number.isSafeInteger(value.cursor) && Number(value.cursor) >= 0)); }
function isAuthChallenge(value: unknown): value is AuthChallenge { return isRecord(value) && value.kind === 'challenge' && typeof value.nonce === 'string' && value.protocol === PROTOCOL_VERSION; }
function isAuthenticated(value: unknown): value is Authenticated { return isRecord(value) && value.kind === 'authenticated' && typeof value.principal === 'string' && typeof value.epoch === 'string' && typeof value.hmac === 'string'; }
function sameProof(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
