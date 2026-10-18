import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { BrowserAgentEval, BrowserAgentEvalError, browserAgentEvalScalar, type BrowserAgentEvalExecutionContext, type BrowserAgentEvalNativeFence } from '../src/browser/agentEval.js';
import type { BrowserEvalExecution, BrowserEvalPreparation, BrowserEvalFence } from '@threadterm/protocol';

const deferred = <T = unknown>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const codeIs = (code: string) => (error: unknown) => error instanceof BrowserAgentEvalError && error.code === code;

function fixture(code = '  "exact bytes";\r\n', clock?: { now(): number }) {
  const registration = { tabId: 'opaque-tab', sourceTabId: 'native-tab', attachmentId: 'attachment', attachmentGeneration: 1, runtimeEpoch: 'runtime', viewGeneration: 1 };
  let document = { sourceTabId: 'native-tab', viewGeneration: 1, documentGeneration: 1, navigationEpoch: 1, url: 'https://page.test/path', loaded: true, available: true, appOrigin: 'https://app.test' };
  const nativeFence: BrowserAgentEvalNativeFence = { registration, grantEpoch: 2, documentGeneration: 1, navigationEpoch: 1, origin: 'https://page.test', url: document.url };
  const preparation: BrowserEvalPreparation = { ...registration, operationId: 'runtime:1', workerGeneration: 'worker', invocationId: 'invocation', callerSessionId: 'caller', turnId: 'turn', codeHash: createHash('sha256').update(code).digest('hex'), codeByteLength: Buffer.byteLength(code), settingsGeneration: 'settings', deadlineUnixMs: Date.now() + 10_000, target: registration };
  // sourceTabId belongs only to the nested registration, never the operation envelope.
  delete (preparation as unknown as Record<string, unknown>).sourceTabId;
  let available = true, destroyed = false, authorized = true, uniqueId = 'context-unique', loaderId = 'loader', contexts = 1, contextOrigin = 'https://page.test';
  const frame = () => ({ frameTree: { frame: { id: 'main-frame', loaderId, url: document.url, securityOrigin: 'https://page.test' } } });
  let respond: (method: string, params?: Record<string, unknown>) => Promise<unknown> = async method => {
    if (method === 'Page.getFrameTree') return frame();
    if (method === 'Runtime.enable') {
      for (let index = 0; index < contexts; index++) client.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: index + 10, uniqueId: index ? `${uniqueId}-${index}` : uniqueId, origin: contextOrigin, auxData: { frameId: 'main-frame', isDefault: true, type: 'default' } } });
    }
    if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'exact bytes' } };
    return {};
  };
  class Debugger extends EventEmitter {
    attached = false; attaches = 0; detaches = 0; commands: { method: string; params?: Record<string, unknown> }[] = [];
    isAttached() { return this.attached; }
    attach() { if (this.attached) throw new Error('conflict'); this.attached = true; this.attaches++; }
    detach() { this.attached = false; this.detaches++; this.emit('detach', {}, 'owned cleanup'); }
    sendCommand(method: string, params?: Record<string, unknown>) { this.commands.push({ method, params }); return respond(method, params); }
  }
  const client = new Debugger();
  let contents = { isDestroyed: () => destroyed, debugger: client, capturePage: async (): Promise<never> => { throw new Error('No screenshot in eval'); } };
  const signal = new AbortController();
  let dispatches = 0;
  const context: BrowserAgentEvalExecutionContext = {
    nativeFence, source: { title: 'Fixture title', url: document.url, origin: nativeFence.origin }, signal: signal.signal,
    getTab: () => ({ contents, document }),
    assertAuthorized: () => { if (!authorized) throw new BrowserAgentEvalError('browser_control_required'); },
    beforeDispatch: async () => { dispatches++; },
  };
  const api = new BrowserAgentEval({ electronVersion: '44.3.0', available: () => available }, clock);
  const executeRequest = (fence: BrowserEvalFence): BrowserEvalExecution => ({ ...fence, invocationId: preparation.invocationId, callerSessionId: preparation.callerSessionId, turnId: preparation.turnId, approvalId: 'approval', code, codeByteLength: Buffer.byteLength(code), deadlineUnixMs: Date.now() + 10_000 });
  const prepare = () => api.prepare(preparation, context);
  return { api, client, nativeFence, preparation, context, signal, frame, prepare, executeRequest,
    get contents() { return contents; }, get document() { return document; }, get dispatches() { return dispatches; }, get respond() { return respond; },
    setDocument(value: typeof document) { document = value; }, replaceContents() { contents = { ...contents }; },
    setRespond(value: typeof respond) { respond = value; }, setAvailable(value: boolean) { available = value; }, setAuthorized(value: boolean) { authorized = value; },
    setUniqueId(value: string) { uniqueId = value; }, setLoader(value: string) { loaderId = value; }, setContexts(value: number) { contexts = value; }, setContextOrigin(value: string) { contextOrigin = value; }, setDestroyed(value: boolean) { destroyed = value; },
  };
}

async function complete(f: ReturnType<typeof fixture>, fence: BrowserEvalFence) {
  const ticket = f.api.execute(f.executeRequest(fence), f.context), result = await ticket.result;
  await ticket.settled;
  return result;
}

test('metadata preparation captures a unique default native context and exports no code/context identity', async () => {
  const f = fixture(), fence = await f.prepare();
  assert.equal(fence.codeHash, f.preparation.codeHash); assert.equal(fence.grantEpoch, 2); assert.ok(Object.isFrozen(fence));
  assert.equal('code' in fence, false); assert.equal('uniqueContextId' in fence, false);
  assert.deepEqual(f.client.commands.map(command => command.method), ['Page.getFrameTree', 'Runtime.enable', 'Page.getFrameTree']);
  assert.equal(f.client.detaches, 1); assert.equal(f.client.listenerCount('message'), 0); assert.equal(f.api.isBusy(f.contents), false);
  assert.equal((await f.prepare()).preparedId, fence.preparedId);
});

test('exact approved bytes dispatch once with no-await/native timeout and release the owned object group', async () => {
  const f = fixture(), fence = await f.prepare(), result = await complete(f, fence);
  assert.deepEqual(result, { outcome: 'completed', source: f.context.source, result: { type: 'string', value: 'exact bytes' } });
  const evaluation = f.client.commands.find(command => command.method === 'Runtime.evaluate')!;
  assert.equal(evaluation.params?.expression, '  "exact bytes";\r\n');
  assert.equal(evaluation.params?.uniqueContextId, 'context-unique'); assert.equal(evaluation.params?.timeout, 250);
  assert.equal(evaluation.params?.awaitPromise, false); assert.equal(evaluation.params?.returnByValue, false);
  assert.equal(evaluation.params?.includeCommandLineAPI, false); assert.equal(evaluation.params?.userGesture, false);
  assert.equal(f.client.commands.some(command => command.method === 'Runtime.terminateExecution'), false);
  assert.equal(f.client.commands.at(-1)?.method, 'Runtime.releaseObjectGroup'); assert.equal(f.dispatches, 1);
  assert.equal((await complete(f, fence)).code, 'browser_eval_expired'); assert.equal(f.dispatches, 1);
});

test('all tagged scalars are explicit and unsupported remote values never invoke serialization', () => {
  for (const [remote, expected] of [
    [{ type: 'undefined' }, { type: 'undefined' }], [{ type: 'object', subtype: 'null', value: null }, { type: 'null' }],
    [{ type: 'boolean', value: false }, { type: 'boolean', value: false }], [{ type: 'number', value: 1.5 }, { type: 'number', value: 1.5 }],
    [{ type: 'string', value: '💾' }, { type: 'string', value: '💾' }],
  ]) assert.deepEqual(browserAgentEvalScalar({ result: remote }), expected);
  for (const remote of [
    { type: 'object', subtype: 'promise', objectId: 'promise' }, { type: 'object', objectId: 'object' }, { type: 'symbol', description: 'secret' },
    { type: 'bigint', unserializableValue: '1n' }, { type: 'number', unserializableValue: 'NaN' }, { type: 'number', value: Infinity },
    { type: 'number', value: 0, unserializableValue: '-0' }, { type: 'string', value: '\ud800' }, { type: 'string', value: '\udc00' },
    { type: 'string', value: '💾'.repeat(4097) }, {},
  ]) assert.throws(() => browserAgentEvalScalar({ result: remote }), codeIs('browser_eval_unsupported_result'));
});

test('UTF-8 scalar and final serialized receipt budgets both reject rather than truncate', async () => {
  assert.equal((browserAgentEvalScalar({ result: { type: 'string', value: '💾'.repeat(4096) } }) as { value: string }).value.length, 8192);
  const f = fixture(), fence = await f.prepare(), original = f.respond;
  f.setRespond(async (method, params) => method === 'Runtime.evaluate' ? { result: { type: 'string', value: '\u0001'.repeat(16 * 1024) } } : original(method, params));
  const result = await complete(f, fence);
  assert.equal(result.code, 'browser_eval_unsupported_result'); assert.equal('result' in result, false); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 60 * 1024);
});

test('native exceptions and proven synchronous termination export fixed codes without page error text or stack', async () => {
  for (const reject of [false, true]) {
    const f = fixture(), fence = await f.prepare(), original = f.respond;
    f.setRespond(async (method, params) => { if (method !== 'Runtime.evaluate') return original(method, params); if (reject) throw new Error('Execution was terminated'); return { result: { type: 'object', objectId: 'error' }, exceptionDetails: { text: 'secret-page-stack', exception: { description: 'secret-page-stack' } } }; });
    const result = await complete(f, fence);
    assert.equal(result.outcome, 'outcome_unknown'); assert.equal(result.code, 'browser_eval_failed'); assert.doesNotMatch(JSON.stringify(result), /secret-page-stack/);
    assert.equal(f.client.commands.at(-1)?.method, 'Runtime.releaseObjectGroup');
  }
});

test('post-dispatch detach or generic transport rejection quarantines the actual native identity until destruction', async () => {
  for (const detach of [false, true]) {
    const f = fixture(), fence = await f.prepare(), pending = deferred(), original = f.respond;
    f.setRespond((method, params) => method === 'Runtime.evaluate' ? pending.promise : original(method, params));
    const ticket = f.api.execute(f.executeRequest(fence), f.context); await turn();
    let settled = false; void ticket.settled.then(() => { settled = true; });
    if (detach) { f.client.emit('detach', {}, 'external'); f.client.attached = true; }
    pending.reject(new Error('untrusted transport detail'));
    const receipt = await ticket.result; await turn();
    assert.equal(receipt.outcome, 'outcome_unknown'); assert.doesNotMatch(JSON.stringify(receipt), /untrusted transport detail/);
    assert.equal(f.api.isBusy(f.contents), true); assert.equal(settled, false); assert.equal(f.api.confirmDestroyed(f.contents), false);
    await assert.rejects(f.api.prepare({ ...f.preparation, operationId: 'runtime:2' }, f.context), codeIs('browser_eval_unavailable'));
    const priorDetaches = f.client.detaches; f.setDestroyed(true); assert.equal(f.api.confirmDestroyed(f.contents), true);
    await ticket.settled; assert.equal(f.api.isBusy(f.contents), false); assert.equal(f.client.detaches, priorDetaches);
    if (detach) assert.equal(priorDetaches, 1);
  }
});

test('prepared retention spans late broker approval while native dispatch uses remaining monotonic budget', async () => {
  let now = 0;
  const f = fixture('1', { now: () => now }), fence = await f.prepare();
  now = 310_000;
  f.context.beforeDispatch = async () => { now += 9900; };
  assert.equal((await complete(f, fence)).outcome, 'completed');
  assert.equal(f.client.commands.find(command => command.method === 'Runtime.evaluate')?.params?.timeout, 100);
  const g = fixture('1', { now: () => now }), other = await g.prepare(); now += 325_001;
  assert.equal((await complete(g, other)).code, 'browser_eval_expired');
});

test('verified native destruction retires a quarantined never-settling command without awaiting its transport', async () => {
  const f = fixture(), fence = await f.prepare(), original = f.respond;
  f.setRespond((method, params) => method === 'Runtime.evaluate' ? new Promise(() => undefined) : original(method, params));
  const ticket = f.api.execute(f.executeRequest(fence), f.context); await turn();
  f.client.emit('detach', {}, 'external'); f.client.attached = true;
  assert.equal((await ticket.result).outcome, 'outcome_unknown'); assert.equal(f.api.isBusy(f.contents), true);
  const idle = f.api.whenIdle(f.contents); f.setDestroyed(true); assert.equal(f.api.confirmDestroyed(f.contents), true);
  await ticket.settled; await idle; assert.equal(f.api.isBusy(f.contents), false); assert.equal(f.client.detaches, 1);
});

test('an exhausted monotonic execution budget blocks dispatch even before a delayed timer runs', async () => {
  let now = 0;
  const f = fixture('1', { now: () => now }), fence = await f.prepare();
  f.context.beforeDispatch = async () => { now = 10_000; };
  const receipt = await complete(f, fence);
  assert.equal(receipt.code, 'browser_deadline'); assert.equal(receipt.outcome, 'outcome_unknown');
  assert.equal(f.client.commands.some(command => command.method === 'Runtime.evaluate'), false);
});

test('the shared-queue remaining budget reduces native timeout and queued deadline keeps its code', async () => {
  const f = fixture(), fence = await f.prepare();
  const ticket = f.api.execute(f.executeRequest(fence), { ...f.context, remainingBudgetMs: 80 });
  assert.equal((await ticket.result).outcome, 'completed'); await ticket.settled;
  const timeout = f.client.commands.find(command => command.method === 'Runtime.evaluate')?.params?.timeout as number;
  assert.ok(timeout > 0 && timeout <= 80);
  const g = fixture(), prepared = await g.prepare(), pending = deferred(), original = g.respond;
  g.setRespond((method, params) => method === 'Runtime.evaluate' ? pending.promise : original(method, params));
  const running = g.api.execute(g.executeRequest(prepared), g.context); await turn(); g.signal.abort('browser_deadline');
  assert.equal((await running.result).code, 'browser_deadline'); pending.resolve({ result: { type: 'undefined' } }); await running.settled;
});

test('discarding one awaiting approval releases only its prepared metadata', async () => {
  const f = fixture(), first = await f.prepare();
  const second = await f.api.prepare({ ...f.preparation, operationId: 'runtime:2' }, f.context);
  f.api.discardPrepared(first.preparedId);
  assert.equal((await complete(f, first)).code, 'browser_eval_expired');
  const request = { ...f.executeRequest(second), operationId: 'runtime:2' };
  const ticket = f.api.execute(request, f.context); assert.equal((await ticket.result).outcome, 'completed'); await ticket.settled;
});

test('changing exact code/hash/length or immutable approval fences consumes preparation without dispatch', async () => {
  for (const change of [
    { code: 'changed bytes' }, { codeHash: 'f'.repeat(64) }, { codeByteLength: 1 }, { grantEpoch: 3 }, { documentGeneration: 2 }, { navigationEpoch: 2 },
    { settingsGeneration: 'changed' }, { callerSessionId: 'other' }, { turnId: 'other' }, { invocationId: 'other' }, { workerGeneration: 'other' }, { attachmentGeneration: 2 },
  ]) {
    const f = fixture(), fence = await f.prepare(), ticket = f.api.execute({ ...f.executeRequest(fence), ...change }, f.context), result = await ticket.result;
    await ticket.settled; assert.notEqual(result.outcome, 'completed'); assert.equal(f.dispatches, 0); assert.equal(f.client.commands.some(command => command.method === 'Runtime.evaluate'), false);
    assert.equal((await complete(f, fence)).code, 'browser_eval_expired');
  }
});

test('native identity, current grant and settings capability are rechecked before dispatch', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.setUniqueId('replaced-context'), (f: ReturnType<typeof fixture>) => f.setLoader('replaced-loader'),
    (f: ReturnType<typeof fixture>) => f.setDocument({ ...f.document, documentGeneration: 2 }), (f: ReturnType<typeof fixture>) => f.replaceContents(),
    (f: ReturnType<typeof fixture>) => f.setAvailable(false), (f: ReturnType<typeof fixture>) => f.setAuthorized(false),
    (f: ReturnType<typeof fixture>) => f.setDocument({ ...f.document, url: 'https://foreign.test/' }),
  ]) {
    const f = fixture(), fence = await f.prepare(); mutate(f); const result = await complete(f, fence);
    assert.notEqual(result.outcome, 'completed'); assert.equal(f.dispatches, 0);
  }
});

test('missing, ambiguous or foreign default contexts fail closed', async () => {
  for (const [count, origin] of [[0, 'https://page.test'], [2, 'https://page.test'], [1, 'https://foreign.test']] as const) {
    const f = fixture(); f.setContexts(count); f.setContextOrigin(origin);
    await assert.rejects(f.prepare(), codeIs('browser_stale_ref')); assert.equal(f.client.detaches, 1);
  }
});

test('dispatch acknowledgment gap rechecks native fences, cancellation and context destruction', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.signal.abort(),
    (f: ReturnType<typeof fixture>) => f.setDocument({ ...f.document, navigationEpoch: 2 }),
    (f: ReturnType<typeof fixture>) => f.client.emit('message', {}, 'Runtime.executionContextDestroyed', { executionContextUniqueId: 'context-unique' }),
  ]) {
    const f = fixture(), fence = await f.prepare(); f.context.beforeDispatch = async () => { mutate(f); };
    const result = await complete(f, fence);
    assert.equal(result.outcome, 'outcome_unknown'); assert.equal(f.client.commands.some(command => command.method === 'Runtime.evaluate'), false);
  }
});

test('exact approved code is captured before an asynchronous dispatch acknowledgment', async () => {
  const f = fixture(), fence = await f.prepare(), gate = deferred<void>(), request = f.executeRequest(fence);
  f.context.beforeDispatch = () => gate.promise;
  const ticket = f.api.execute(request, f.context);
  await turn(); request.code = 'mutated after approval'; gate.resolve();
  assert.equal((await ticket.result).outcome, 'completed'); await ticket.settled;
  assert.equal(f.client.commands.find(command => command.method === 'Runtime.evaluate')?.params?.expression, '  "exact bytes";\r\n');
});

test('Stop returns unknown but holds native lane until actual evaluation and object cleanup settle', async () => {
  const f = fixture(), fence = await f.prepare(), pending = deferred(), cleanup = deferred(), original = f.respond;
  f.setRespond((method, params) => method === 'Runtime.evaluate' ? pending.promise : method === 'Runtime.releaseObjectGroup' ? cleanup.promise : original(method, params));
  const ticket = f.api.execute(f.executeRequest(fence), f.context); await turn();
  let settled = false; void ticket.settled.then(() => { settled = true; });
  f.signal.abort(); assert.equal((await ticket.result).outcome, 'outcome_unknown'); assert.equal(f.api.isBusy(f.contents), true); assert.equal(settled, false);
  pending.resolve({ result: { type: 'number', value: 2 } }); await turn(); assert.equal(f.api.isBusy(f.contents), true); assert.equal(settled, false);
  cleanup.resolve({}); await ticket.settled; assert.equal(f.api.isBusy(f.contents), false); assert.equal(f.client.detaches, 2);
  assert.equal(f.client.commands.some(command => command.method === 'Runtime.terminateExecution'), false);
});

test('post-dispatch deadline returns bounded uncertainty without releasing unresolved native work', async () => {
  const f = fixture(), fence = await f.prepare(), pending = deferred(), original = f.respond;
  f.setRespond((method, params) => method === 'Runtime.evaluate' ? pending.promise : original(method, params));
  const ticket = f.api.execute({ ...f.executeRequest(fence), deadlineUnixMs: Date.now() + 25 }, f.context), result = await ticket.result;
  assert.equal(result.outcome, 'outcome_unknown'); assert.equal(result.code, 'browser_deadline'); assert.equal(f.api.isBusy(f.contents), true);
  pending.resolve({ result: { type: 'undefined' } }); await ticket.settled; assert.equal(f.api.isBusy(f.contents), false);
});

test('prepare deadline retains its unsettled native lane and never creates a late prepared permit', async () => {
  const f = fixture(), pending = deferred(), original = f.respond;
  f.setRespond((method, params) => method === 'Page.getFrameTree' ? pending.promise : original(method, params));
  await assert.rejects(f.api.prepare({ ...f.preparation, deadlineUnixMs: Date.now() + 20 }, f.context), codeIs('browser_deadline'));
  assert.equal(f.api.isBusy(f.contents), true); pending.resolve(f.frame()); await turn(); assert.equal(f.api.isBusy(f.contents), false);
  assert.equal(f.client.detaches, 1); assert.equal(f.client.commands.some(command => command.method === 'Runtime.evaluate'), false);
});

test('Off/lifecycle invalidation retires preparation and stops an active result while retaining native latch', async () => {
  const f = fixture(), fence = await f.prepare(); f.api.invalidate('native-tab'); assert.equal((await complete(f, fence)).code, 'browser_eval_expired');
  const g = fixture(), prepared = await g.prepare(), pending = deferred(), original = g.respond;
  g.setRespond((method, params) => method === 'Runtime.evaluate' ? pending.promise : original(method, params));
  const ticket = g.api.execute(g.executeRequest(prepared), g.context); await turn(); g.api.clear();
  assert.equal((await ticket.result).code, 'browser_cancelled'); assert.equal(g.api.isBusy(g.contents), true);
  pending.resolve({ result: { type: 'undefined' } }); await ticket.settled;
});

test('debugger conflicts and external ownership loss never detach another debugger', async () => {
  const f = fixture(); f.client.attached = true;
  await assert.rejects(f.prepare(), codeIs('browser_eval_unavailable')); assert.equal(f.client.detaches, 0);
  const g = fixture(), original = g.respond;
  g.setRespond(async (method, params) => { const response = await original(method, params); g.client.emit('detach', {}, 'external'); g.client.attached = true; return response; });
  await assert.rejects(g.prepare(), codeIs('browser_eval_unavailable')); assert.equal(g.client.detaches, 0); assert.equal(g.client.listenerCount('detach'), 0);
});

test('pinned version/capability and loaded HTTP origin checks are mandatory', async () => {
  const f = fixture();
  const unsupported = new BrowserAgentEval({ electronVersion: '44.3.1', available: () => true });
  await assert.rejects(unsupported.prepare(f.preparation, f.context), codeIs('browser_eval_unavailable'));
  for (const url of ['about:blank', 'https://app.test/', 'blob:https://page.test/value']) {
    const g = fixture(); g.setDocument({ ...g.document, url }); await assert.rejects(g.prepare());
  }
  const g = fixture(); g.setDocument({ ...g.document, loaded: false }); await assert.rejects(g.prepare(), codeIs('browser_unavailable'));
});
