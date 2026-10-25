import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { appendFile, closeSync, existsSync, fstatSync, openSync, readFile, readFileSync, readSync } from 'node:fs';
import { platform, env, hrtime } from 'node:process';
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
  isBrowserPrivateFrame,
  validateBrowserDesktopRequest,
  validateBrowserDesktopResult,
  type BrowserPrivateFrame,
  type BrowserDesktopMethod,
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
const SEND_TRACE_ENV = 'THREADTERM_V3_SEND_TRACE';
const MAX_CORRELATION_ID_LENGTH = 128;
const MAX_PENDING_SEND_TRACE_RECORDS = 256;
const BROWSER_REQUEST_TIMEOUT_MS = 10_000;
const MAX_BROWSER_PENDING_REQUESTS = 64;
const MAX_BROWSER_REGISTRATION_REQUESTS = 48;
const MAX_STARTUP_FAILURE_LOG_BYTES = 64 * 1024;

type SendTraceMethod = 'chat.send' | 'chat.draft.save';
interface SendTraceContext {
  requestId: string;
  operationId?: string;
  sessionId?: string;
  method: SendTraceMethod;
  started: bigint;
}

let sendTraceOrigin: bigint | undefined;
const pendingSendTraceRecords: string[] = [];
let sendTraceWriteActive = false;
let sendTracePathResolving = false;
let sendTraceLogPath: string | undefined;

function resolveSendTraceLogPath(): void {
  if (sendTraceLogPath || sendTracePathResolving) return;
  try {
    if (env.THREADTERM_V3_DATA) {
      sendTraceLogPath = join(env.THREADTERM_V3_DATA, 'runtime.log');
      drainSendTraceRecords();
      return;
    }
    sendTracePathResolving = true;
    readFile(join(app.getPath('userData'), 'runtime-data-root.json'), 'utf8', (_error, contents) => {
      try {
        let root: string | undefined;
        try {
          const value = JSON.parse(contents) as unknown;
          if (isRecord(value) && typeof value.root === 'string' && value.root) root = value.root;
        } catch {}
        const dataRoot = root || join(env.LOCALAPPDATA || env.APPDATA || app.getPath('appData'), 'ThreadTermV3');
        sendTraceLogPath = join(dataRoot, 'runtime.log');
      } catch {
        pendingSendTraceRecords.length = 0;
      }
      sendTracePathResolving = false;
      if (sendTraceLogPath && pendingSendTraceRecords.length) drainSendTraceRecords();
    });
  } catch {
    sendTracePathResolving = false;
    pendingSendTraceRecords.length = 0;
  }
}

function drainSendTraceRecords(): void {
  if (sendTraceWriteActive) return;
  if (!sendTraceLogPath) { resolveSendTraceLogPath(); return; }
  const line = pendingSendTraceRecords.shift();
  if (!line) return;
  sendTraceWriteActive = true;
  try {
    appendFile(sendTraceLogPath, line, 'utf8', () => {
      sendTraceWriteActive = false;
      drainSendTraceRecords();
    });
  } catch {
    sendTraceWriteActive = false;
    pendingSendTraceRecords.length = 0;
  }
}

function sendTraceMethod(method: string): SendTraceMethod | undefined {
  if (env[SEND_TRACE_ENV] !== '1') return undefined;
  if (method === 'chat.send' || method === 'chat.draft.save') return method;
  return undefined;
}

function safeCorrelationId(value: unknown): string | undefined {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_CORRELATION_ID_LENGTH
    && /^[A-Za-z0-9_.:-]+$/.test(value)
    ? value
    : undefined;
}

/**
 * Appends to the existing readable runtime log. Each process owns a separate
 * monotonic clock; correlate records by ID and compare durations, never clocks.
 */
function emitSendTrace(
  stage: 'desktop.request.begin' | 'desktop.request.write' | 'desktop.request.end',
  context: SendTraceContext,
  outcome?: 'ok' | 'error',
): void {
  if (env[SEND_TRACE_ENV] !== '1') return;
  const now = hrtime.bigint();
  sendTraceOrigin ??= now;
  const record = {
    kind: 'threadterm.sendTrace',
    schema: 1,
    source: 'desktop',
    monotonicUs: Number((now - sendTraceOrigin) / 1_000n),
    stage,
    requestId: context.requestId,
    ...(context.operationId ? { operationId: context.operationId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    method: context.method,
    ...(outcome ? { outcome } : {}),
    durationUs: Number((now - context.started) / 1_000n),
  };
  if (pendingSendTraceRecords.length >= MAX_PENDING_SEND_TRACE_RECORDS) return;
  pendingSendTraceRecords.push(`${JSON.stringify(record)}\n`);
  drainSendTraceRecords();
}

interface PendingRuntimeStartup { child: ChildProcess; logPath: string; logOffset: number }
const pendingRuntimeStartups = new Map<string, Set<PendingRuntimeStartup>>();
const startupFailureCodes = new Map<string, string>();

interface ControlRequest { v: 1; id: string; method: string; params: Record<string, unknown> }
interface ControlResponse { v: 1; id: string; result?: unknown; error?: RuntimeError }
interface AuthChallenge { kind: 'challenge'; nonce: string; protocol: number; contract?: number }
interface AuthRequest { kind: 'auth'; clientId: string; protocol: number; contract: number; nonce: string; hmac: string }
interface Authenticated { kind: 'authenticated'; principal: string; epoch: string; hmac: string; contract?: number }
interface PendingRequest { method: Method|'qa.chat.projection.fail'; resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
interface BrowserControlSession { control: LengthPrefixedSocket; pipe: string; token: string; epoch: string }
interface BrowserConnectionAttempt { session: BrowserControlSession; connection?: LengthPrefixedSocket; promise: Promise<LengthPrefixedSocket> }
interface PendingBrowserRequest { method: BrowserDesktopMethod; resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
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

/**
 * Waits only for runtime processes launched by this desktop process which have
 * not yet reached a usable control pipe. This never launches or reconnects a
 * client, so shutdown can close the race between suspension and a late bind.
 */
export async function waitForPendingRuntimeStartup(timeoutMs = 30_000): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('Runtime startup timeout must be a non-negative finite number');
  const deadline = Date.now() + timeoutMs;
  const { control } = await runtimePipes();
  while (pendingRuntimeStartups.get(control)?.size) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new RuntimeUnavailableError('Timed out waiting for the launched runtime to bind its control pipe');
    if (await pipeIsOpen(control, Math.min(CONNECT_TIMEOUT_MS, remaining))) {
      pendingRuntimeStartups.delete(control);
      return;
    }
    if (!pendingRuntimeStartups.get(control)?.size) return;
    const delayMs = Math.min(RETRY_DELAY_MS, deadline - Date.now());
    if (delayMs <= 0) throw new RuntimeUnavailableError('Timed out waiting for the launched runtime to bind its control pipe');
    await delay(delayMs);
  }
}

export class RuntimeClient {
  constructor(private readonly options: { autoLaunch?: boolean } = {}) {}
  private control?: LengthPrefixedSocket;
  private output?: LengthPrefixedSocket;
  private browser?: LengthPrefixedSocket;
  private browserCapabilityEpoch?: string;
  private browserSession?: BrowserControlSession;
  private browserSessionRevision = 0;
  private browserConnecting?: BrowserConnectionAttempt;
  private readonly browserPending = new Map<string, PendingBrowserRequest>();
  private readonly browserFrameListeners = new Set<(frame: BrowserPrivateFrame) => void>();
  private readonly browserDisconnectListeners = new Set<(error: Error) => void>();
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
  private disconnectRevision = 0;
  private incompatible?: ProtocolIncompatibleError;
  private qaReconnectPaused = false;

  async request<M extends Method>(method: M, params: RequestParams<M>): Promise<RequestResult<M>> {
    if (this.qaReconnectPaused) throw new RuntimeUnavailableError('Runtime reconnect is paused for QA');
    await this.ensureConnected();
    this.assertOpen();
    const id = randomUUID();
    const message: ControlRequest = { v: PROTOCOL_VERSION, id, method, params: params as Record<string, unknown> };
    const tracedMethod = sendTraceMethod(method);
    const trace = tracedMethod ? {
      requestId: id,
      operationId: safeCorrelationId(message.params.operationId),
      sessionId: safeCorrelationId(message.params.sessionId),
      method: tracedMethod,
      started: hrtime.bigint(),
    } satisfies SendTraceContext : undefined;
    if (trace) emitSendTrace('desktop.request.begin', trace);
    const response = new Promise<RequestResult<M>>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RuntimeUnavailableError(`Runtime request ${method} timed out`));
      }, 30_000);
      this.pending.set(id, { method, resolve: resolvePromise as (value: unknown) => void, reject, timer });
      try {
        this.control?.write(Buffer.from(JSON.stringify(message), 'utf8'));
        if (trace) emitSendTrace('desktop.request.write', trace);
      }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(asError(error)); }
    });
    try {
      const result = await response;
      if (trace) emitSendTrace('desktop.request.end', trace, 'ok');
      return result;
    } catch (error) {
      if (trace) emitSendTrace('desktop.request.end', trace, 'error');
      throw error;
    }
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }

  /** Main-only capability transport; deliberately absent from renderer IPC. */
  browserRequest(method: BrowserDesktopMethod, params: Record<string, unknown>): Promise<unknown> {
    try {
      this.assertOpen();
      validateBrowserDesktopRequest(method, params);
      const limit = method.startsWith('browser.desktop.') ? MAX_BROWSER_PENDING_REQUESTS : MAX_BROWSER_REGISTRATION_REQUESTS;
      if (this.browserPending.size >= limit) throw new RuntimeUnavailableError('Browser request capacity is exhausted');
    } catch (error) { return Promise.reject(asError(error)); }
    const id = randomUUID();
    const capabilityEpoch = params.runtimeEpoch;
    return new Promise((resolvePromise, reject) => {
      const payload = Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, id, method, params }), 'utf8');
      const pending: PendingBrowserRequest = {
        method, resolve: resolvePromise, reject,
        timer: setTimeout(() => {
          if (this.browserPending.get(id) !== pending) return;
          this.invalidateBrowser(new RuntimeUnavailableError('Browser request timed out'));
        }, BROWSER_REQUEST_TIMEOUT_MS),
      };
      this.browserPending.set(id, pending);
      void (async () => {
        const connection = await this.ensureBrowserConnected(method === 'browser.attach' || method === 'browser.registerTab');
        this.assertOpen();
        if (this.browser !== connection || this.browserPending.get(id) !== pending) return;
        if (method !== 'browser.attach' && !this.browserCapabilityEpoch) throw new RuntimeUnavailableError('Browser attachment is unavailable');
        if (method.startsWith('browser.desktop.') && capabilityEpoch !== this.browserCapabilityEpoch) {
          throw new RuntimeUnavailableError('Browser capability epoch changed');
        }
        connection.write(payload);
      })().catch(error => {
        if (this.browserPending.get(id) !== pending) return;
        clearTimeout(pending.timer);
        this.browserPending.delete(id);
        reject(asError(error));
      });
    });
  }

  onBrowserFrame(listener: (frame: BrowserPrivateFrame) => void): () => void { this.browserFrameListeners.add(listener); return () => this.browserFrameListeners.delete(listener); }
  onBrowserDisconnect(listener: (error: Error) => void): () => void { this.browserDisconnectListeners.add(listener); return () => this.browserDisconnectListeners.delete(listener); }

  private async ensureBrowserConnected(allowConnect: boolean): Promise<LengthPrefixedSocket> {
    this.assertOpen();
    const session = this.browserSession ?? (allowConnect ? await this.refreshBrowserSession() : undefined);
    this.assertOpen();
    if (!this.browserPending.size) throw new RuntimeUnavailableError('Browser request is no longer pending');
    if (!session || this.control !== session.control) throw new RuntimeUnavailableError('Browser control session is unavailable');
    if (this.browser) return this.browser;
    if (!allowConnect) throw new RuntimeUnavailableError('Browser attachment connection is unavailable');
    if (this.browserConnecting) return this.browserConnecting.promise;
    const attempt: BrowserConnectionAttempt = { session, promise: undefined! };
    this.browserConnecting = attempt;
    attempt.promise = (async () => {
      const connection = await LengthPrefixedSocket.connect(session.pipe);
      attempt.connection = connection;
      try {
        this.assertBrowserSession(session, attempt);
        await authenticate(connection, session.token, this.clientId, (authenticated, proofFrame) => {
          this.assertBrowserSession(session, attempt);
          if (authenticated.epoch !== session.epoch) throw new RuntimeUnavailableError('Browser runtime epoch changed');
          // Install synchronously with proof verification, before another frame
          // in the same socket chunk can be consumed.
          this.browser = connection;
          this.browserCapabilityEpoch = undefined;
          connection.onFrame(frame => {
            if (frame !== proofFrame && this.browser === connection) this.handleBrowserFrame(frame, connection, session);
          });
          connection.onFailure(error => { if (this.browser === connection) this.invalidateBrowser(error); });
        });
        this.assertBrowserSession(session, attempt);
        if (this.browser !== connection) throw new RuntimeUnavailableError('Browser connection closed during authentication');
        return connection;
      } catch (error) {
        if (this.browserConnecting === attempt || this.browser === connection) this.invalidateBrowser(asError(error));
        connection.close();
        throw error;
      }
    })().finally(() => { if (this.browserConnecting === attempt) this.browserConnecting = undefined; });
    return attempt.promise;
  }

  private async refreshBrowserSession(): Promise<BrowserControlSession> {
    const control = this.control;
    const epoch = this.runtimeEpoch;
    const revision = this.browserSessionRevision;
    if (!control || !this.output || !epoch) throw new RuntimeUnavailableError('Browser control session is unavailable');
    // A cancelled shutdown discarded the previous credential cache. Only a
    // fresh explicit attachment may read it again; resume itself stays idle.
    const pipes = await runtimePipes();
    this.assertOpen();
    if (this.control !== control || this.runtimeEpoch !== epoch || this.browserSessionRevision !== revision) {
      throw new RuntimeUnavailableError('Browser control session was replaced');
    }
    const token = readCredential();
    if (!token) throw new RuntimeUnavailableError('Browser control credential is unavailable');
    return this.browserSession ??= { control, pipe: pipes.browser, token, epoch };
  }

  private assertBrowserSession(session: BrowserControlSession, attempt: BrowserConnectionAttempt): void {
    this.assertOpen();
    if (this.browserSession !== session || this.control !== session.control || this.browserConnecting !== attempt) {
      throw new RuntimeUnavailableError('Browser control session was replaced');
    }
  }

  private handleBrowserFrame(frame: Buffer, connection: LengthPrefixedSocket, session: BrowserControlSession): void {
    try {
      if (this.browser !== connection || this.browserSession !== session || this.control !== session.control) return;
      const value: unknown = JSON.parse(frame.toString('utf8'));
      if (isBrowserPrivateFrame(value)) {
        if (!this.browserCapabilityEpoch) throw new RuntimeUnavailableError('Browser attachment has not been established');
        if (value.params.runtimeEpoch !== this.browserCapabilityEpoch) throw new RuntimeUnavailableError('Browser capability epoch changed');
        for (const listener of this.browserFrameListeners) listener(value);
        return;
      }
      if (!isControlResponse(value) || Object.keys(value).some(key => !['v', 'id', 'result', 'error'].includes(key))) {
        throw new Error('Runtime sent an invalid browser response');
      }
      const pending = this.browserPending.get(value.id);
      if (!pending) return;
      if (!value.error) {
        validateBrowserDesktopResult(pending.method, value.result);
        if (pending.method === 'browser.attach' || pending.method === 'browser.registerTab') {
          if (!isRecord(value.result) || typeof value.result.runtimeEpoch !== 'string'
            || pending.method === 'browser.registerTab' && !this.browserCapabilityEpoch
            || this.browserCapabilityEpoch !== undefined && value.result.runtimeEpoch !== this.browserCapabilityEpoch) {
            throw new RuntimeUnavailableError('Browser capability epoch changed');
          }
          // Browser capability epochs are fresh per service, independently of
          // the authenticated control epoch retained by the runtime database.
          this.browserCapabilityEpoch = value.result.runtimeEpoch;
        }
      }
      clearTimeout(pending.timer);
      this.browserPending.delete(value.id);
      if (value.error) pending.reject(new RuntimeRequestError(value.error));
      else pending.resolve(value.result);
    } catch (error) { this.invalidateBrowser(asError(error)); }
  }

  private invalidateBrowser(error: Error, invalidateSession = false): void {
    const connection = this.browser;
    const attempt = this.browserConnecting;
    const active = Boolean(connection || attempt || this.browserPending.size);
    this.browser = undefined;
    this.browserCapabilityEpoch = undefined;
    this.browserConnecting = undefined;
    if (invalidateSession) { this.browserSession = undefined; this.browserSessionRevision++; }
    connection?.close();
    if (attempt?.connection !== connection) attempt?.connection?.close();
    for (const pending of this.browserPending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.browserPending.clear();
    if (active) for (const listener of this.browserDisconnectListeners) listener(error);
  }

  /** Test-only: the Electron IPC handler also requires the non-packaged QA flag. */
  dropControlForQa(): boolean {
    if (env.THREADTERM_V3_RELOCATION_QA !== '1' || !this.control) return false;
    this.qaReconnectPaused = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.control.close();
    return true;
  }

  resumeControlForQa(): boolean {
    if (env.THREADTERM_V3_RELOCATION_QA !== '1' || !this.qaReconnectPaused) return false;
    this.qaReconnectPaused = false;
    void this.ensureConnected().catch(() => {});
    return true;
  }

  async failChatProjectionForQa(sessionId: string): Promise<void> {
    if (env.THREADTERM_V3_RELOCATION_QA !== '1' || !sessionId || sessionId.length > 256) throw new Error('QA projection failure is unavailable');
    await this.ensureConnected();
    this.assertOpen();
    const id = randomUUID();
    return new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('QA projection request timed out')); }, 30_000);
      this.pending.set(id, { method: 'qa.chat.projection.fail', resolve: () => resolvePromise(), reject, timer });
      try { this.control?.write(Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, id, method: 'qa.chat.projection.fail', params: { sessionId } }), 'utf8')); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(asError(error)); }
    });
  }

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
    this.invalidateBrowser(new RuntimeUnavailableError('Desktop is closing'), true);
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
    if (suspended) this.invalidateBrowser(new RuntimeUnavailableError('Desktop shutdown is in progress'), true);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (!suspended && !this.expectedDisconnect) {
      void this.ensureConnected().catch(() => {});
    }
  }

  private async ensureConnected(): Promise<void> {
    this.assertOpen();
    if (this.qaReconnectPaused) throw new RuntimeUnavailableError('Runtime reconnect is paused for QA');
    if (this.incompatible) throw this.incompatible;
    if (this.control && this.output) return;
    if (!this.connecting) {
      const disconnectRevision = this.disconnectRevision;
      this.connecting = this.connectAndAuthenticate().catch(error => {
        // Initial startup can exhaust readiness before the daemon binds its pipes.
        // Recover the connection as for an established disconnect; callers still
        // receive their original failure and no request is replayed. A pipe which
        // failed during this attempt has already performed this transition.
        const failure = asError(error);
        if (failure instanceof ProtocolIncompatibleError || this.disconnectRevision === disconnectRevision) {
          this.handleDisconnect(failure);
        }
        throw error;
      }).finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }

  private async connectAndAuthenticate(): Promise<void> {
    const pipes = await runtimePipes();
    this.assertOpen();
    if (!readCredential()) {
      if (this.options.autoLaunch === false) throw new RuntimeUnavailableError('Runtime is not running');
      await launchRuntimeIfNeeded(pipes.control, () => this.assertOpen());
    }
    this.assertOpen();
    let token: string;
    try { token = await waitForCredential(); }
    catch (error) { throw startupFailure(pipes.control) ?? error; }
    this.assertOpen();
    let control: LengthPrefixedSocket;
    try { control = await connectUntilReady(pipes.control, CONNECT_TIMEOUT_MS); }
    catch {
      this.assertOpen();
      if (this.options.autoLaunch === false) throw new RuntimeUnavailableError('Runtime is not running');
      await launchRuntimeIfNeeded(pipes.control, () => this.assertOpen());
      this.assertOpen();
      try { control = await connectUntilReady(pipes.control, RUNTIME_READY_TIMEOUT_MS); }
      catch (error) { throw startupFailure(pipes.control) ?? error; }
    }
    try {
      this.assertOpen();
      const session = await authenticate(control, token, this.clientId);
      markRuntimeStartupReady(pipes.control);
      this.assertOpen();
      const controlFailure = this.attachControl(control);
      const outputAttempt = connectUntilReady(pipes.output, RUNTIME_READY_TIMEOUT_MS);
      let output: LengthPrefixedSocket;
      try { output = await Promise.race([outputAttempt, controlFailure]); }
      catch (error) {
        // A control failure can win while the output connection attempt is
        // still running. Close any pipe that the losing attempt opens later.
        void outputAttempt.then(connection => connection.close(), () => {});
        throw error;
      }
      try {
        this.assertOpen();
        await Promise.race([authenticate(output, token, this.clientId), controlFailure]);
        this.assertOpen();
        if (this.control !== control) throw new RuntimeUnavailableError('Runtime control pipe closed during connection');
        this.attachOutput(output);
      }
      catch (error) { output.close(); throw error; }
      const previousEpoch = this.runtimeEpoch;
      this.runtimeEpoch = session.epoch;
      this.invalidateBrowser(new RuntimeUnavailableError('Runtime control session was replaced'), true);
      this.browserSession = { control, pipe: pipes.browser, token, epoch: session.epoch };
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
      throw error;
    }
  }

  async whenConnectionAttemptSettled(): Promise<void> {
    const connecting = this.connecting;
    if (!connecting) return;
    try { await connecting; } catch {}
  }

  private attachControl(control: LengthPrefixedSocket): Promise<never> {
    this.control = control;
    control.onFrame((frame) => { if (this.control === control) this.handleControlFrame(frame); });
    return new Promise((_, reject) => {
      control.onFailure((error) => {
        if (this.control !== control) return;
        this.handleDisconnect(error);
        reject(error);
      });
    });
  }

  private attachOutput(output: LengthPrefixedSocket): void {
    this.output = output;
    output.onFrame((frame) => {
      void this.handleOutputFrame(frame, output).catch((error) => {
        if (this.output === output) this.handleDisconnect(asError(error));
      });
    });
    output.onFailure((error) => { if (this.output === output) this.handleDisconnect(error); });
    for (const group of this.outputGroups.values()) {
      this.sendOutputFrame(3, { sessionId: group.sessionId, cursor: group.cursor });
      this.sendOutputFrame(2, { sessionId: group.sessionId, credit: INITIAL_OUTPUT_CREDIT });
    }
  }

  private handleControlFrame(frame: Buffer): void {
    let value: unknown;
    try { value = JSON.parse(frame.toString('utf8')) as unknown; } catch { this.handleDisconnect(new Error('Runtime sent invalid JSON')); return; }
    // Browser-prefixed traffic must never reach the renderer event fanout,
    // including unknown/malformed future private notifications.
    if (isRecord(value) && ((typeof value.method === 'string' && value.method.startsWith('browser.'))
      || (typeof value.event === 'string' && value.event.startsWith('browser.')))) {
      this.handleDisconnect(new Error('Runtime sent browser traffic on the control pipe'));
      return;
    }
    if (isRuntimeEvent(value)) { for (const listener of this.eventListeners) listener(value); return; }
    if (!isControlResponse(value)) { this.handleDisconnect(new Error('Runtime sent an invalid control response')); return; }
    const pending = this.pending.get(value.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(value.id);
    if (value.error) pending.reject(new RuntimeRequestError(value.error));
    else {
      try {
        if (pending.method === 'qa.chat.projection.fail') {
          if (env.THREADTERM_V3_RELOCATION_QA !== '1' || value.result !== null) throw new Error('Invalid QA projection result');
        } else validateResult(pending.method, value.result);
        if (pending.method === 'runtime.shutdown') this.control?.write(Buffer.from(JSON.stringify({ kind: 'shutdownAck', id: value.id }), 'utf8'));
        pending.resolve(value.result);
      }
      catch (error) { pending.reject(asError(error)); }
    }
  }

  private async handleOutputFrame(frame: Buffer, origin = this.output): Promise<void> {
    if (origin && this.output !== origin) return;
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
    group.delivery = delivery.catch((error) => {
      if (!origin || this.output === origin) this.handleDisconnect(asError(error));
    });
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
    this.disconnectRevision++;
    this.disconnecting = true;
    const control = this.control;
    const output = this.output;
    this.control = undefined;
    this.output = undefined;
    this.invalidateBrowser(error, true);
    control?.close();
    output?.close();
    this.disconnecting = false;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (error instanceof ProtocolIncompatibleError) {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.incompatible = error;
      this.emitSynthetic('runtime.transport', { state: 'incompatible', message: error.message });
      return;
    }
    this.sawDisconnect = true;
    this.emitSynthetic('runtime.transport', { state: 'disconnected', epoch: this.runtimeEpoch, reason: error.message });
    if (this.incompatible || this.suspended || this.qaReconnectPaused) return;
    if (!this.reconnectTimer) this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensureConnected().catch(() => {});
    }, RETRY_DELAY_MS);
  }

  private emitSynthetic(event: string, data: Record<string, unknown>): void {
    const payload: RuntimeEvent = { v: 1, event, epoch: this.runtimeEpoch || '', seq: 0, data };
    for (const listener of this.eventListeners) listener(payload);
  }
}

let sidHash: Promise<string> | undefined;

async function runtimePipes(): Promise<{ control: string; output: string; browser: string }> {
  const configured = env.THREADTERM_V3_PIPE;
  if (configured && !configured.startsWith('\\\\.\\pipe\\')) throw new RuntimeUnavailableError('THREADTERM_V3_PIPE must be a Windows named-pipe path');
  const base = configured || `\\\\.\\pipe\\threadterm-v3-${await currentUserSidHash()}`;
  return { control: `${base}-control`, output: `${base}-output`, browser: `${base}-browser` };
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
async function authenticate(connection: LengthPrefixedSocket, token: string, clientId: string, onAuthenticated?: (session: { epoch: string }, proofFrame: Buffer) => void): Promise<{ epoch: string }> {
  return new Promise((resolvePromise, reject) => {
    let nonce = '';
    const timeout = setTimeout(() => { cleanup(); reject(new RuntimeUnavailableError('Runtime authentication timed out')); }, CONNECT_TIMEOUT_MS);
    const cleanup = () => { clearTimeout(timeout); removeFrame(); removeFailure(); };
    const removeFrame = connection.onFrame((frame) => {
      try {
        const value = JSON.parse(frame.toString('utf8')) as unknown;
        const challenge = parseAuthChallenge(value);
        if (challenge) {
          nonce = challenge.nonce;
          const hmac = createHmac('sha256', token).update(`${challenge.protocol}:${clientId}:${challenge.nonce}`).digest('hex');
          connection.write(Buffer.from(JSON.stringify({ kind: 'auth', clientId, protocol: PROTOCOL_VERSION, contract: PROTOCOL_CONTRACT, nonce: challenge.nonce, hmac } satisfies AuthRequest), 'utf8'));
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
        onAuthenticated?.({ epoch: value.epoch }, frame);
        resolvePromise({ epoch: value.epoch });
      } catch (error) { cleanup(); reject(asError(error)); }
    });
    const removeFailure = connection.onFailure((error) => { cleanup(); reject(error); });
  });
}
async function launchRuntimeIfNeeded(controlPipe: string, assertOpen: () => void): Promise<void> {
  const { spawn } = await import('node:child_process');
  const { mkdirSync, statSync } = await import('node:fs');
  // Suspension or disposal may happen while the lazy imports resolve. Keep the
  // irreversible spawn on the current side of that asynchronous boundary.
  assertOpen();
  const executable = resolveRuntimeExecutable();
  const runtimeEnv: NodeJS.ProcessEnv = { ...env, THREADTERM_V3_DATA: v3DataDirectory() };
  if (env.THREADTERM_CLAUDE_NODE) {
    delete runtimeEnv.THREADTERM_CLAUDE_ELECTRON_NODE;
  } else {
    runtimeEnv.THREADTERM_CLAUDE_NODE = process.execPath;
    runtimeEnv.THREADTERM_CLAUDE_ELECTRON_NODE = '1';
  }
  // The runtime is otherwise a silent detached daemon; keep its stderr on file
  // so projection and bind failures stay diagnosable after the fact. On a first
  // launch the data folder does not exist yet (the runtime creates its own files).
  mkdirSync(v3DataDirectory(), { recursive: true });
  const logPath = join(v3DataDirectory(), 'runtime.log');
  let logOffset = 0;
  try { logOffset = statSync(logPath).size; } catch {}
  const log = openSync(logPath, 'a');
  const child = (() => {
    try {
      return executable.kind === 'cargo'
        ? spawn('cargo', ['run', '--manifest-path', executable.path, '--bin', 'threadterm-v3-runtime'], { cwd: app.getAppPath(), detached: true, stdio: ['ignore', log, log], windowsHide: true, env: runtimeEnv })
        : spawn(executable.path, [], { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: runtimeEnv });
    } finally {
      closeSync(log);
    }
  })();
  startupFailureCodes.delete(controlPipe);
  trackRuntimeStartup(controlPipe, child, logPath, logOffset);
  child.unref();
}

function trackRuntimeStartup(controlPipe: string, child: ChildProcess, logPath: string, logOffset: number): void {
  const tracker: PendingRuntimeStartup = { child, logPath, logOffset };
  let tracked = pendingRuntimeStartups.get(controlPipe);
  if (!tracked) {
    tracked = new Set();
    pendingRuntimeStartups.set(controlPipe, tracked);
  }
  tracked.add(tracker);
  const remove = () => {
    const current = pendingRuntimeStartups.get(controlPipe);
    if (!current?.delete(tracker)) return;
    if (current.size === 0) pendingRuntimeStartups.delete(controlPipe);
    const code = startupFailureCode(tracker);
    if (code) startupFailureCodes.set(controlPipe, code);
  };
  child.once('exit', remove);
  child.once('error', remove);
  if (child.exitCode !== null || child.signalCode !== null) remove();
}

function markRuntimeStartupReady(controlPipe: string): void {
  pendingRuntimeStartups.delete(controlPipe);
  startupFailureCodes.delete(controlPipe);
}

function startupFailure(controlPipe: string): RuntimeUnavailableError | undefined {
  const code = startupFailureCodes.get(controlPipe);
  return code ? new RuntimeUnavailableError(code) : undefined;
}

function startupFailureCode({ logPath, logOffset }: PendingRuntimeStartup): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(logPath, 'r');
    const size = fstatSync(descriptor).size;
    const start = Math.max(logOffset, size - MAX_STARTUP_FAILURE_LOG_BYTES);
    const length = size - start;
    if (length <= 0) return undefined;
    const output = Buffer.allocUnsafe(length);
    const bytesRead = readSync(descriptor, output, 0, length, start);
    return /\b(schema_too_new|schema_backup_failed)\b(?=[:\s]|$)/.exec(output.subarray(0, bytesRead).toString('utf8'))?.[1];
  } catch { return undefined; }
  finally { if (descriptor !== undefined) try { closeSync(descriptor); } catch {} }
}

function pipeIsOpen(pipe: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolvePromise => {
    const socket = net.createConnection(pipe);
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(open);
    };
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
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
export function parseAuthChallenge(value: unknown): AuthChallenge | undefined {
  if (!isRecord(value) || value.kind !== 'challenge') return undefined;
  const reason = protocolIncompatibleReason(value, 'desktop');
  if (reason) throw new ProtocolIncompatibleError(reason);
  if (typeof value.nonce !== 'string' || value.protocol !== PROTOCOL_VERSION) throw new Error('Runtime sent an invalid authentication challenge');
  return value as unknown as AuthChallenge;
}
function isAuthenticated(value: unknown): value is Authenticated { return isRecord(value) && value.kind === 'authenticated' && typeof value.principal === 'string' && typeof value.epoch === 'string' && typeof value.hmac === 'string'; }
function sameProof(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
