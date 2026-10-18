import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isBrowserEvalReceipt, isBrowserPrivateFrame, type BrowserActionSource, type BrowserEvalError, type BrowserEvalExecution, type BrowserEvalFence, type BrowserEvalPreparation, type BrowserEvalReceipt, type BrowserEvalScalar } from '@threadterm/protocol';
import { browserAgentOrigin, clipBrowserAgentText, type BrowserAgentNativeTab, type BrowserAgentRegistration } from './agentTypes.js';

const NATIVE_BUDGET_MS = 250;
// Retention covers publication latency, the broker's five-minute approval and fresh execution budget.
// This is storage retention, never an execution permit.
const PREPARED_LIFETIME_MS = 325_000;
const PREPARED_LIMIT = 128;
const RESULT_BYTES = 60 * 1024;
const SCALAR_BYTES = 16 * 1024;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};

export class BrowserAgentEvalError extends Error {
  constructor(readonly code: BrowserEvalError) { super('Browser evaluation is unavailable or its authorization changed.'); this.name = 'BrowserAgentEvalError'; }
}

/** Captured by main from its Control grant, never from renderer or page data. */
export interface BrowserAgentEvalNativeFence {
  readonly registration: BrowserAgentRegistration;
  readonly grantEpoch: number;
  readonly documentGeneration: number;
  readonly navigationEpoch: number;
  readonly origin: string;
  readonly url: string;
}

export interface BrowserAgentEvalContext {
  readonly nativeFence: BrowserAgentEvalNativeFence;
  readonly source: BrowserActionSource;
  readonly signal?: AbortSignal;
  getTab(): BrowserAgentNativeTab | undefined;
  /** Main checks Control, settings, caller/turn/worker and the exact private operation. */
  assertAuthorized(): void;
}

export interface BrowserAgentEvalExecutionContext extends BrowserAgentEvalContext {
  /** Remaining local monotonic admission budget after the shared tab queue. */
  readonly remainingBudgetMs?: number;
  /** Send browser.desktop.dispatch and require accepted:true before resolving. */
  beforeDispatch(): Promise<void>;
}

export interface BrowserAgentEvalTicket {
  readonly result: Promise<BrowserEvalReceipt>;
  /** The tab lane must remain occupied until this settles, even after result resolves. */
  readonly settled: Promise<void>;
}

interface NativeIdentity { frameId: string; loaderId: string; uniqueContextId: string }
interface Prepared {
  request: Readonly<BrowserEvalPreparation>;
  fence: Readonly<BrowserEvalFence>;
  nativeFence: BrowserAgentEvalNativeFence;
  contents: BrowserAgentNativeTab['contents'];
  identity: NativeIdentity;
  source: BrowserActionSource;
  expiresAt: number;
}
interface Session {
  command(method: string, params?: JsonObject): Promise<unknown>;
  identity(origin: string, url: string): Promise<NativeIdentity>;
  valid(identity: NativeIdentity): boolean;
  release(group: string): Promise<void>;
}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const registrationKeys = ['tabId', 'sourceTabId', 'attachmentId', 'attachmentGeneration', 'runtimeEpoch', 'viewGeneration'] as const;
function sameRegistration(left: BrowserAgentRegistration, right: BrowserAgentRegistration): boolean {
  return registrationKeys.every(key => left[key] === right[key]);
}
function copyFence(fence: BrowserAgentEvalNativeFence): BrowserAgentEvalNativeFence {
  return Object.freeze({ ...fence, registration: Object.freeze({ ...fence.registration }) });
}
function sameNativeFence(left: BrowserAgentEvalNativeFence, right: BrowserAgentEvalNativeFence): boolean {
  return sameRegistration(left.registration, right.registration) && left.grantEpoch === right.grantEpoch && left.documentGeneration === right.documentGeneration
    && left.navigationEpoch === right.navigationEpoch && left.origin === right.origin && left.url === right.url;
}
function failed(code: BrowserEvalError, dispatched = false, source?: BrowserActionSource): BrowserEvalReceipt {
  return { outcome: dispatched ? 'outcome_unknown' : code === 'browser_cancelled' ? 'cancelled' : 'failed', code, ...(source ? { source } : {}) };
}
function errorCode(error: unknown): BrowserEvalError {
  return error instanceof BrowserAgentEvalError ? error.code : 'browser_eval_failed';
}

/** No arbitrary property traversal, object serialization, exception text or Promise awaiting. */
export function browserAgentEvalScalar(response: unknown): BrowserEvalScalar {
  const envelope = object(response), remote = object(envelope.result);
  if (envelope.exceptionDetails !== undefined) throw new BrowserAgentEvalError('browser_eval_failed');
  if (remote.objectId !== undefined || remote.unserializableValue !== undefined) throw new BrowserAgentEvalError('browser_eval_unsupported_result');
  let scalar: BrowserEvalScalar;
  if (remote.type === 'undefined' && remote.value === undefined && remote.subtype === undefined) scalar = { type: 'undefined' };
  else if (remote.type === 'object' && remote.subtype === 'null' && remote.value === null) scalar = { type: 'null' };
  else if (remote.type === 'boolean' && typeof remote.value === 'boolean' && remote.subtype === undefined) scalar = { type: 'boolean', value: remote.value };
  else if (remote.type === 'number' && typeof remote.value === 'number' && Number.isFinite(remote.value) && remote.subtype === undefined) scalar = { type: 'number', value: remote.value };
  else if (remote.type === 'string' && typeof remote.value === 'string' && remote.subtype === undefined && Buffer.byteLength(remote.value, 'utf8') <= SCALAR_BYTES && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(remote.value)) scalar = { type: 'string', value: remote.value };
  else throw new BrowserAgentEvalError('browser_eval_unsupported_result');
  return Object.freeze(scalar);
}

/** Conservative pinned-native adapter. Construction does not enable any product capability. */
export class BrowserAgentEval {
  private readonly prepared = new Map<string, Prepared>();
  private readonly busy = new Set<BrowserAgentNativeTab['contents']>();
  private readonly active = new Map<BrowserAgentNativeTab['contents'], { sourceTabId: string; stop(): void }>();
  private readonly quarantine = new Map<BrowserAgentNativeTab['contents'], { settled: Promise<void>; release(): void }>();
  private readonly idle = new Map<BrowserAgentNativeTab['contents'], { settled: Promise<void>; release(): void }>();
  private readonly destruction = new Map<BrowserAgentNativeTab['contents'], () => void>();

  constructor(private readonly capability: { electronVersion: string; available(): boolean }, private readonly clock: { now(): number } = performance) {}

  isBusy(contents: BrowserAgentNativeTab['contents']): boolean { return this.busy.has(contents); }

  discardPrepared(preparedId: string): void { this.prepared.delete(preparedId); }

  whenIdle(contents: BrowserAgentNativeTab['contents']): Promise<void> { return this.idle.get(contents)?.settled ?? Promise.resolve(); }

  /** Called only for the exact native object after main observes its actual destruction. */
  confirmDestroyed(contents: BrowserAgentNativeTab['contents']): boolean {
    if (!contents.isDestroyed()) return false;
    this.destruction.get(contents)?.();
    this.quarantine.get(contents)?.release(); this.quarantine.delete(contents);
    return true;
  }

  invalidate(sourceTabId: string): void {
    for (const [id, record] of this.prepared) if (record.nativeFence.registration.sourceTabId === sourceTabId) this.prepared.delete(id);
    for (const active of this.active.values()) if (active.sourceTabId === sourceTabId) active.stop();
  }

  clear(): void {
    this.prepared.clear();
    for (const active of this.active.values()) active.stop();
  }

  async prepare(request: BrowserEvalPreparation, context: BrowserAgentEvalContext): Promise<BrowserEvalFence> {
    if (!isBrowserPrivateFrame({ method: 'browser.eval.prepare', params: request })) throw new BrowserAgentEvalError('browser_eval_unavailable');
    const captured = Object.freeze({ ...request, target: Object.freeze({ ...request.target }) });
    const deadline = this.clock.now() + Math.min(10_000, request.deadlineUnixMs - Date.now());
    const nativeFence = copyFence(context.nativeFence), contents = this.check(context, request.deadlineUnixMs, undefined, nativeFence, deadline).contents;
    if (!sameRegistration(nativeFence.registration, captured.target) || nativeFence.registration.tabId !== captured.tabId) throw new BrowserAgentEvalError('browser_stale_ref');
    const source = this.source(context, nativeFence);
    for (const [id, record] of this.prepared) {
      if (record.expiresAt <= this.clock.now()) this.prepared.delete(id);
      else if (record.request.operationId === captured.operationId && record.request.runtimeEpoch === captured.runtimeEpoch) {
        if (!same(record.request, captured) || !sameNativeFence(record.nativeFence, nativeFence) || record.contents !== contents) throw new BrowserAgentEvalError('browser_eval_unavailable');
        return record.fence;
      }
    }
    if (this.prepared.size >= PREPARED_LIMIT) throw new BrowserAgentEvalError('browser_eval_unavailable');
    if (this.busy.has(contents)) throw new BrowserAgentEvalError('browser_eval_unavailable');
    let stopped = false, rejectStopped: (error: Error) => void = () => undefined;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
    const stop = (): void => { stopped = true; rejectStopped(new BrowserAgentEvalError('browser_cancelled')); };
    const timer = setTimeout(() => { stopped = true; rejectStopped(new BrowserAgentEvalError('browser_deadline')); }, Math.max(1, deadline - this.clock.now()));
    context.signal?.addEventListener('abort', stop, { once: true });
    this.active.set(contents, { sourceTabId: nativeFence.registration.sourceTabId, stop });
    const work = this.session(contents, async session => {
      const identity = await session.identity(nativeFence.origin, nativeFence.url);
      if (stopped) throw new BrowserAgentEvalError('browser_cancelled');
      this.check(context, captured.deadlineUnixMs, contents, nativeFence, deadline);
      if (!session.valid(identity)) throw new BrowserAgentEvalError('browser_stale_ref');
      return identity;
    }).then(identity => {
      if (stopped) throw new BrowserAgentEvalError('browser_cancelled');
      this.check(context, captured.deadlineUnixMs, contents, nativeFence, deadline);
      const fence = Object.freeze({ operationId: captured.operationId, workerGeneration: captured.workerGeneration, preparedId: randomUUID(), tabId: captured.tabId, codeHash: captured.codeHash, settingsGeneration: captured.settingsGeneration, origin: nativeFence.origin, documentGeneration: nativeFence.documentGeneration, navigationEpoch: nativeFence.navigationEpoch, grantEpoch: nativeFence.grantEpoch, attachmentId: captured.attachmentId, attachmentGeneration: captured.attachmentGeneration, runtimeEpoch: captured.runtimeEpoch, viewGeneration: captured.viewGeneration });
      this.prepared.set(fence.preparedId, { request: captured, fence, nativeFence, contents, identity, source, expiresAt: this.clock.now() + PREPARED_LIFETIME_MS });
      return fence;
    }).finally(() => { clearTimeout(timer); context.signal?.removeEventListener('abort', stop); if (this.active.get(contents)?.stop === stop) this.active.delete(contents); });
    return Promise.race([work, interrupted]);
  }

  execute(request: BrowserEvalExecution, context: BrowserAgentEvalExecutionContext): BrowserAgentEvalTicket {
    // Capture exact primitive bytes before any native or dispatch await.
    request = Object.freeze({ ...request });
    const queueBudget = context.remainingBudgetMs === undefined ? Infinity : Number.isFinite(context.remainingBudgetMs) ? context.remainingBudgetMs : 0;
    const deadline = this.clock.now() + Math.min(10_000, request.deadlineUnixMs - Date.now(), queueBudget);
    let deliver: (receipt: BrowserEvalReceipt) => void = () => undefined;
    const result = new Promise<BrowserEvalReceipt>(resolve => { deliver = resolve; });
    let delivered = false, stopped = false, dispatched = false, source: BrowserActionSource | undefined;
    const complete = (receipt: BrowserEvalReceipt): void => { if (!delivered) { delivered = true; deliver(Object.freeze(receipt)); } };
    const stop = (): void => { stopped = true; complete(failed(context.signal?.reason === 'browser_deadline' ? 'browser_deadline' : 'browser_cancelled', dispatched, source)); };
    let timer: ReturnType<typeof setTimeout> | undefined, contents: BrowserAgentNativeTab['contents'] | undefined;
    const work = async (): Promise<void> => {
      try {
        const record = this.prepared.get(request.preparedId);
        // Consume on every attempt; no failed dispatch or delivery can replay approved code.
        this.prepared.delete(request.preparedId);
        if (!isBrowserPrivateFrame({ method: 'browser.eval.execute', params: request })) throw new BrowserAgentEvalError('browser_eval_unavailable');
        if (!record || record.expiresAt <= this.clock.now()) throw new BrowserAgentEvalError('browser_eval_expired');
        if (!Object.keys(record.fence).every(key => record.fence[key as keyof BrowserEvalFence] === request[key as keyof BrowserEvalFence])
          || request.invocationId !== record.request.invocationId || request.callerSessionId !== record.request.callerSessionId || request.turnId !== record.request.turnId
          || request.codeByteLength !== record.request.codeByteLength || createHash('sha256').update(request.code, 'utf8').digest('hex') !== record.request.codeHash
          || !sameNativeFence(record.nativeFence, context.nativeFence)) throw new BrowserAgentEvalError('browser_stale_ref');
        contents = this.check(context, request.deadlineUnixMs, record.contents, record.nativeFence, deadline).contents;
        source = record.source;
        if (this.busy.has(contents)) throw new BrowserAgentEvalError('browser_eval_unavailable');
        timer = setTimeout(() => { stopped = true; complete(failed('browser_deadline', dispatched, source)); }, Math.max(1, deadline - this.clock.now()));
        context.signal?.addEventListener('abort', stop, { once: true });
        this.active.set(contents, { sourceTabId: record.nativeFence.registration.sourceTabId, stop });
        const scalar = await this.session(contents, async session => {
          const identity = await session.identity(record.nativeFence.origin, record.nativeFence.url);
          if (!same(identity, record.identity)) throw new BrowserAgentEvalError('browser_stale_ref');
          this.check(context, request.deadlineUnixMs, contents, record.nativeFence, deadline);
          if (stopped || !session.valid(identity)) throw new BrowserAgentEvalError('browser_stale_ref');
          // An uncertain dispatch acknowledgment must never cause a retry.
          dispatched = true;
          await context.beforeDispatch();
          this.check(context, request.deadlineUnixMs, contents, record.nativeFence, deadline);
          if (stopped || !session.valid(identity)) throw new BrowserAgentEvalError('browser_stale_ref');
          const nativeBudget = Math.min(NATIVE_BUDGET_MS, Math.floor(deadline - this.clock.now()));
          if (nativeBudget < 1) throw new BrowserAgentEvalError('browser_deadline');
          const group = `threadterm-eval-${randomUUID()}`;
          try {
            const response = await session.command('Runtime.evaluate', { expression: request.code, uniqueContextId: identity.uniqueContextId, objectGroup: group, includeCommandLineAPI: false, userGesture: false, generatePreview: false, returnByValue: false, awaitPromise: false, timeout: nativeBudget, serializationOptions: { serialization: 'idOnly' } });
            this.check(context, request.deadlineUnixMs, contents, record.nativeFence, deadline);
            if (stopped || !session.valid(identity)) throw new BrowserAgentEvalError('browser_stale_ref');
            return browserAgentEvalScalar(response);
          } finally { await session.release(group); }
        }, () => complete(failed('browser_eval_failed', true, source)));
        this.check(context, request.deadlineUnixMs, contents, record.nativeFence, deadline);
        if (stopped) throw new BrowserAgentEvalError('browser_cancelled');
        const receipt: BrowserEvalReceipt = { outcome: 'completed', source, result: scalar };
        if (!isBrowserEvalReceipt(receipt) || Buffer.byteLength(JSON.stringify(receipt), 'utf8') > RESULT_BYTES) throw new BrowserAgentEvalError('browser_eval_unsupported_result');
        complete(receipt);
      } catch (error) { complete(failed(errorCode(error), dispatched, source)); }
      finally {
        if (timer) clearTimeout(timer);
        context.signal?.removeEventListener('abort', stop);
        if (contents && this.active.get(contents)?.stop === stop) this.active.delete(contents);
      }
    };
    return Object.freeze({ result, settled: work() });
  }

  private source(context: BrowserAgentEvalContext, fence: BrowserAgentEvalNativeFence): BrowserActionSource {
    const source = Object.freeze({ title: clipBrowserAgentText(context.source.title, 512), url: fence.url, origin: fence.origin });
    if (context.source.url !== fence.url || context.source.origin !== fence.origin || !isBrowserEvalReceipt({ outcome: 'completed', source, result: { type: 'undefined' } })) throw new BrowserAgentEvalError('browser_eval_unavailable');
    return source;
  }

  private check(context: BrowserAgentEvalContext, deadline: number, contents?: BrowserAgentNativeTab['contents'], expected = context.nativeFence, monotonicDeadline = Infinity): BrowserAgentNativeTab {
    if (this.capability.electronVersion !== '44.3.0' || !this.capability.available()) throw new BrowserAgentEvalError('browser_eval_unavailable');
    if (context.signal?.aborted) throw new BrowserAgentEvalError(context.signal.reason === 'browser_deadline' ? 'browser_deadline' : 'browser_cancelled');
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || this.clock.now() >= monotonicDeadline) throw new BrowserAgentEvalError('browser_deadline');
    context.assertAuthorized();
    const tab = context.getTab(), document = tab?.document;
    if (!tab || !document || tab.contents.isDestroyed() || contents && contents !== tab.contents || !document.available || !document.loaded) throw new BrowserAgentEvalError('browser_unavailable');
    if (!sameNativeFence(context.nativeFence, expected) || !Number.isSafeInteger(expected.grantEpoch) || expected.grantEpoch < 1 || document.sourceTabId !== expected.registration.sourceTabId
      || document.viewGeneration !== expected.registration.viewGeneration || document.documentGeneration !== expected.documentGeneration || document.navigationEpoch !== expected.navigationEpoch
      || document.url !== expected.url || browserAgentOrigin(document.url) !== expected.origin || expected.origin === document.appOrigin || !/^https?:\/\//.test(document.url)) throw new BrowserAgentEvalError('browser_stale_ref');
    return tab;
  }

  private async session<T>(contents: BrowserAgentNativeTab['contents'], run: (session: Session) => Promise<T>, uncertain?: () => void): Promise<T> {
    if (this.busy.has(contents) || contents.debugger.isAttached() || contents.isDestroyed()) throw new BrowserAgentEvalError('browser_eval_unavailable');
    this.busy.add(contents);
    let releaseIdle: () => void = () => undefined;
    this.idle.set(contents, { settled: new Promise<void>(resolve => { releaseIdle = resolve; }), release: () => releaseIdle() });
    const client = contents.debugger;
    let rejectDestroyed: (error: Error) => void = () => undefined;
    const destroyed = new Promise<never>((_resolve, reject) => { rejectDestroyed = reject; });
    void destroyed.catch(() => undefined);
    this.destruction.set(contents, () => rejectDestroyed(new BrowserAgentEvalError('browser_unavailable')));
    let owned = false, detached = false, collecting = false, evaluated = false;
    const contexts = new Map<string, JsonObject>();
    const quarantine = (): void => {
      if (!this.quarantine.has(contents)) {
        let release: () => void = () => undefined;
        this.quarantine.set(contents, { settled: new Promise<void>(resolve => { release = resolve; }), release: () => release() });
      }
      uncertain?.();
    };
    const onDetach = (): void => {
      if (owned && evaluated) quarantine();
      owned = false; detached = true;
    };
    const onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string): void => {
      if (sessionId) return;
      const data = object(params);
      if (method === 'Runtime.executionContextsCleared') contexts.clear();
      else if (method === 'Runtime.executionContextDestroyed') {
        for (const [id, context] of contexts) if (context.id === data.executionContextId || id === data.executionContextUniqueId) contexts.delete(id);
      } else if (method === 'Runtime.executionContextCreated') {
        const context = object(data.context);
        if (typeof context.uniqueId === 'string' && contexts.size < 4096) contexts.set(context.uniqueId, context);
      }
    };
    const attached = (): void => { if (!owned || detached || !client.isAttached() || contents.isDestroyed()) throw new BrowserAgentEvalError('browser_eval_unavailable'); };
    const command = async (method: string, params?: JsonObject): Promise<unknown> => {
      attached();
      // Never race this native promise against Stop/deadline. Its actual settlement owns the lane.
      if (method === 'Runtime.evaluate') evaluated = true;
      let result: unknown;
      try {
        // Only verified destruction can retire an otherwise unsettled native command.
        result = await Promise.race([client.sendCommand(method, params), destroyed]);
      }
      catch (error) {
        // The pinned native termination rejection proves synchronous execution ended.
        // Generic transport rejection does not; keep the physical contents quarantined.
        if (evaluated && !contents.isDestroyed() && !(method === 'Runtime.evaluate' && error instanceof Error && error.message === 'Execution was terminated')) quarantine();
        throw new BrowserAgentEvalError('browser_eval_failed');
      }
      attached();
      return result;
    };
    const frame = (value: unknown, origin: string, url: string): { frameId: string; loaderId: string } => {
      const tree = object(object(value).frameTree), main = object(tree.frame);
      if (typeof main.id !== 'string' || !main.id || typeof main.loaderId !== 'string' || !main.loaderId || main.parentId !== undefined || main.url !== url || main.securityOrigin !== origin) throw new BrowserAgentEvalError('browser_stale_ref');
      return { frameId: main.id, loaderId: main.loaderId };
    };
    const session: Session = {
      command,
      async identity(origin, url) {
        if (collecting) throw new BrowserAgentEvalError('browser_eval_unavailable');
        collecting = true;
        const before = frame(await command('Page.getFrameTree'), origin, url);
        await command('Runtime.enable');
        const after = frame(await command('Page.getFrameTree'), origin, url);
        const matches = [...contexts.entries()].filter(([, context]) => { const aux = object(context.auxData); return context.origin === origin && aux.frameId === after.frameId && aux.isDefault === true && aux.type === 'default' && Number.isSafeInteger(context.id); });
        if (!same(before, after) || matches.length !== 1) throw new BrowserAgentEvalError('browser_stale_ref');
        return { ...after, uniqueContextId: matches[0][0] };
      },
      valid(identity) { attached(); return contexts.has(identity.uniqueContextId); },
      async release(group) { attached(); await command('Runtime.releaseObjectGroup', { objectGroup: group }); },
    };
    client.on('detach', onDetach); client.on('message', onMessage);
    try {
      client.attach('1.3');
      if (detached || !client.isAttached()) throw new BrowserAgentEvalError('browser_eval_unavailable');
      owned = true;
      return await run(session);
    } finally {
      try { if (owned && client.isAttached()) { owned = false; client.detach(); } }
      finally {
        client.removeListener('message', onMessage); client.removeListener('detach', onDetach);
        if (this.quarantine.has(contents)) {
          if (contents.isDestroyed()) this.confirmDestroyed(contents);
          await this.quarantine.get(contents)?.settled;
        }
        this.busy.delete(contents); this.idle.get(contents)?.release(); this.idle.delete(contents); this.destruction.delete(contents);
      }
    }
  }
}
