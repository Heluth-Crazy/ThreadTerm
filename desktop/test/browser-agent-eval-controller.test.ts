import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { BrowserAgentController } from '../src/browser/agentController.js';
import { BrowserAgentGrants } from '../src/browser/agentGrants.js';
import { isBrowserSharingState } from '../../renderer/src/browserTypes.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(probe: () => boolean) { for (let index = 0; index < 200; index++) { if (probe()) return; await turn(); } throw new Error('Fixture did not settle'); }
const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(yes => { resolve = yes; }); return { promise, resolve }; };

function fixture(capability = true) {
  const events = new EventEmitter(), calls: any[] = [], replies: any[] = [], prepared: any[] = [], registrations = new Map<string, any>(), attachments = new Map<string, any>(), gates = new Map<string, Promise<unknown>>();
  let sequence = 0, captures = 0, destroyed = false;
  let document = { sourceTabId: 'source', viewGeneration: 1, documentGeneration: 1, navigationEpoch: 1, url: 'http://127.0.0.1:4001/page', available: true, loaded: true };
  const workspace = { id: 'workspace', revision: 1, projectId: 'project', worktreePath: 'D:/fixture/work', layout: { kind: 'pane', id: 'pane', tabs: [{ id: 'source', kind: 'web', url: document.url }], activeTabId: 'source' } };
  let respond: (method: string, params?: Record<string, unknown>) => Promise<unknown> = async method => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'loader', url: document.url, securityOrigin: 'http://127.0.0.1:4001' } } };
    if (method === 'Runtime.enable') client.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 10, uniqueId: 'unique-context', origin: 'http://127.0.0.1:4001', auxData: { frameId: 'frame', isDefault: true, type: 'default' } } });
    return method === 'Runtime.evaluate' ? { result: { type: 'number', value: 42 } } : {};
  };
  class Debugger extends EventEmitter {
    attached = false; commands: any[] = [];
    isAttached() { return this.attached; }
    attach() { this.attached = true; }
    detach() { this.attached = false; this.emit('detach', {}, 'owned cleanup'); }
    sendCommand(method: string, params?: Record<string, unknown>) { this.commands.push({ method, params }); return respond(method, params); }
  }
  const client = new Debugger();
  const image = { isEmpty: () => false, getSize: () => ({ width: 100, height: 50 }), toPNG: () => Buffer.from('image'), toJPEG: () => Buffer.from('image'), resize() { return this; } };
  const contents = { debugger: client, isDestroyed: () => destroyed, capturePage: async () => { captures++; return image; } };
  const runtime = {
    async browserRequest(method: any, params: any) {
      calls.push({ method, params });
      if (gates.has(method)) await gates.get(method);
      if (method === 'browser.attach') { const attachment = { attachmentId: `attachment-${++sequence}`, attachmentGeneration: 1, runtimeEpoch: 'epoch', viewGeneration: params.viewGeneration }; attachments.set(attachment.attachmentId, attachment); return attachment; }
      if (method === 'browser.registerTab') { const registration = { ...attachments.get(params.attachmentId), sourceTabId: params.sourceTabId, tabId: `handle-${sequence}` }; registrations.set(registration.tabId, registration); return registration; }
      if (method === 'browser.unregisterTab') { registrations.delete(params.tabId); return { unregistered: true }; }
      if (method === 'browser.detach') return { detached: true };
      if (method === 'browser.desktop.reply') replies.push(params);
      if (method === 'browser.desktop.evalPrepared') prepared.push(params);
      return { accepted: true };
    },
    onBrowserFrame(fn: any) { events.on('frame', fn); return () => events.off('frame', fn); },
    onBrowserDisconnect(fn: any) { events.on('disconnect', fn); return () => events.off('disconnect', fn); },
    onEvent(fn: any) { events.on('event', fn); return () => events.off('event', fn); },
    async snapshot() { return { workspaces: [workspace] as any }; },
  };
  const controller = new BrowserAgentController(runtime, { getTab: id => id === 'source' && !destroyed ? { document, contents, title: 'Fixture title' } : undefined, changed: () => undefined, electronVersion: '44.3.0', evalCapability: () => capability });
  const share = (level: 'read' | 'control' = 'control') => controller.share({ type: 'share', tabId: 'source', level, workspace: { id: 'workspace', revision: 1 }, expected: { documentGeneration: document.documentGeneration, ...controller.state('source') } });
  const target = () => [...registrations.values()].at(-1);
  const envelope = (id: number) => { const { tabId: _tabId, sourceTabId: _source, ...attachment } = target(); return { ...attachment, operationId: `epoch:${id}`, workerGeneration: 'worker', invocationId: `host:${id}`, callerSessionId: 'caller' }; };
  const preparation = (id: number, code = 'globalThis.fixtureEffect++; 42') => ({ ...envelope(id), turnId: 'turn', tabId: target().tabId, codeHash: createHash('sha256').update(code).digest('hex'), codeByteLength: Buffer.byteLength(code), settingsGeneration: 'settings', deadlineUnixMs: Date.now() + 10_000, target: target() });
  const execution = (fence: any, code = 'globalThis.fixtureEffect++; 42') => ({ ...fence, invocationId: `host:${fence.operationId.split(':').at(-1)}`, callerSessionId: 'caller', turnId: 'turn', approvalId: 'approval', code, codeByteLength: Buffer.byteLength(code), deadlineUnixMs: Date.now() + 10_000 });
  const emit = (method: string, params: any) => events.emit('frame', { method, params });
  const prepare = async (id: number) => { const prior = prepared.length; emit('browser.eval.prepare', preparation(id)); await until(() => prepared.length > prior); return prepared.at(-1); };
  const read = (id: number, tool = 'browser_screenshot') => ({ ...envelope(id), deadlineUnixMs: Date.now() + 10_000, tool, arguments: tool === 'browser_list_tabs' ? {} : { tabId: target().tabId }, targets: [target()] });
  return { controller, client, calls, replies, prepared, share, prepare, preparation, execution, emit, read, target, contents, get captures() { return captures; }, get respond() { return respond; }, setRespond(value: typeof respond) { respond = value; }, get document() { return document; }, setDocument(value: typeof document) { document = value; }, setDestroyed(value: boolean) { destroyed = value; }, defer(method: string) { const gate = deferred(); gates.set(method, gate.promise); return () => { gates.delete(method); gate.resolve({}); }; }, dispose() { controller.dispose(); } };
}

test('trusted capability defaults closed while Read survives and unproven ordinary actions never dispatch', async () => {
  const f = fixture(false);
  try {
    assert.equal(f.controller.state('source').controlAvailable, false); await assert.rejects(f.share()); assert.equal(f.calls.length, 0);
    await f.share('read'); const click = f.read(1, 'browser_click'); click.arguments = { tabId: f.target().tabId, ref: 'ref-1' } as any;
    f.emit('browser.execute', click); await until(() => f.replies.length === 1);
    assert.equal(f.client.commands.length, 0); assert.match(JSON.stringify(f.replies[0].result), /browser_unavailable/);
  } finally { f.dispose(); }
});

test('Control registration is fresh, includes Read, and downgrades immediately while loading', async () => {
  const f = fixture();
  try {
    await f.share('read'); const previous = f.target(); await f.share(); assert.notEqual(f.target().tabId, previous.tabId);
    assert.ok(f.calls.some(call => call.method === 'browser.unregisterTab' && call.params.tabId === previous.tabId));
    f.emit('browser.execute', f.read(1, 'browser_list_tabs')); await until(() => f.replies.length === 1); assert.equal(f.replies[0].result.tabs[0].shareLevel, 'control');
    f.emit('browser.execute', f.read(2)); await until(() => f.replies.length === 2); assert.equal(f.replies[1].result.content[1].type, 'image');
    f.setDocument({ ...f.document, loaded: false }); await f.share('read'); assert.equal(f.controller.state('source').level, 'read');
    assert.equal(isBrowserSharingState(f.controller.state('source')), true);
  } finally { f.dispose(); }
});

test('Read supersedes a pending Control registration, immediately revokes it and revalidates the same document', async () => {
  const f = fixture();
  try {
    await f.share('read'); const finish = f.defer('browser.attach');
    const upgrading = f.share(), rejected = assert.rejects(upgrading); await until(() => f.controller.state('source').status === 'sharing');
    const downgrade = f.share('read'); assert.equal(f.controller.state('source').level, 'off');
    finish(); await rejected; await downgrade; assert.equal(f.controller.state('source').level, 'read');
    assert.equal(f.calls.filter(call => call.method === 'browser.registerTab').length, 2);
  } finally { f.dispose(); }
});

test('a later Off supersedes pending Control-to-Read continuation after blocked registration cleanup', async () => {
  const f = fixture();
  try {
    await f.share('read'); const finish = f.defer('browser.attach');
    const upgrading = f.share(), rejected = assert.rejects(upgrading); await until(() => f.controller.state('source').status === 'sharing');
    const downgrade = f.share('read'), off = f.controller.share({ type: 'share', tabId: 'source', level: 'off' });
    assert.equal(f.controller.state('source').level, 'off'); finish(); await rejected; await downgrade; await off;
    assert.equal(f.controller.state('source').level, 'off'); assert.equal(f.controller.state('source').status, 'idle');
    assert.equal(f.calls.filter(call => call.method === 'browser.registerTab').length, 1);
  } finally { f.dispose(); }
});

test('native eval metadata and exact dispatch handshake stay private and duplicate execution cannot replay', async () => {
  const f = fixture();
  try {
    await f.share(); const fence = await f.prepare(1), request = f.execution(fence);
    assert.equal('code' in fence, false); assert.equal('uniqueContextId' in fence, false);
    f.emit('browser.eval.execute', request); await until(() => f.replies.length === 1);
    assert.deepEqual(f.replies[0].result.result, { type: 'number', value: 42 });
    const dispatch = f.calls.find(call => call.method === 'browser.desktop.dispatch'); assert.equal(dispatch.params.preparedId, fence.preparedId); assert.equal(dispatch.params.approvalId, 'approval'); assert.equal('code' in dispatch.params, false);
    assert.equal(f.client.commands.filter(command => command.method === 'Runtime.evaluate').length, 1);
    f.emit('browser.eval.execute', request); await until(() => f.replies.length === 2); assert.equal(f.client.commands.filter(command => command.method === 'Runtime.evaluate').length, 1);
    f.emit('browser.eval.execute', { ...request, code: 'x'.repeat(request.codeByteLength) }); await until(() => f.replies.length === 3); assert.equal(f.replies[2].result.code, 'browser_eval_denied');
    assert.doesNotMatch(JSON.stringify(f.controller.state('source')), /preparedId|codeHash|fixtureEffect|approvalId/);
  } finally { f.dispose(); }
});

test('same-document navigation invalidates awaiting approval and sends a bounded invalidation receipt', async () => {
  const f = fixture();
  try {
    await f.share(); const fence = await f.prepare(1);
    f.controller.navigationStarted('source', `${f.document.url}#next`); f.setDocument({ ...f.document, navigationEpoch: 2, url: `${f.document.url}#next` });
    f.emit('browser.eval.execute', f.execution(fence)); await turn();
    assert.equal(f.controller.state('source').level, 'control'); assert.equal(f.client.commands.some(command => command.method === 'Runtime.evaluate'), false);
    assert.ok(f.calls.some(call => call.method === 'browser.desktop.evalInvalidated' && call.params.preparedId === fence.preparedId));
  } finally { f.dispose(); }
});

test('user operation Stop is exact and queued Read waits through native eval settlement', async () => {
  const f = fixture(), pending = deferred();
  try {
    await f.share(); const fence = await f.prepare(1), original = f.respond;
    f.setRespond((method, params) => method === 'Runtime.evaluate' ? pending.promise : original(method, params));
    f.emit('browser.eval.execute', f.execution(fence)); await until(() => f.client.commands.some(command => command.method === 'Runtime.evaluate'));
    f.emit('browser.execute', f.read(2)); f.controller.stopAgentOperation('foreign-tab', fence.operationId); await turn(); assert.equal(f.replies.length, 0);
    f.controller.stopAgentOperation('source', fence.operationId); await until(() => f.replies.length === 1);
    assert.equal(f.replies[0].result.outcome, 'outcome_unknown'); assert.equal(f.captures, 0);
    pending.resolve({ result: { type: 'number', value: 42 } }); await until(() => f.replies.length === 2); assert.equal(f.captures, 1);
  } finally { pending.resolve({ result: { type: 'undefined' } }); f.dispose(); }
});

test('cancelled queued eval has no native dispatch and approval preparation occupies no waiting tab slot', async () => {
  const f = fixture(), pending = deferred();
  try {
    await f.share(); const first = await f.prepare(1), second = await f.prepare(2), original = f.respond;
    f.setRespond((method, params) => method === 'Runtime.evaluate' ? pending.promise : original(method, params));
    f.emit('browser.eval.execute', f.execution(first)); await until(() => f.client.commands.some(command => command.method === 'Runtime.evaluate'));
    f.emit('browser.eval.execute', f.execution(second)); f.controller.stopAgentOperation('source', second.operationId); await until(() => f.replies.length === 1);
    assert.equal(f.replies[0].result.outcome, 'cancelled'); pending.resolve({ result: { type: 'number', value: 42 } }); await until(() => f.replies.length === 2);
    assert.equal(f.client.commands.filter(command => command.method === 'Runtime.evaluate').length, 1);
  } finally { pending.resolve({}); f.dispose(); }
});

test('Read/eval share one active plus four queued slots, including after uncertain result release', async () => {
  const f = fixture(), pending = deferred();
  try {
    await f.share(); const fence = await f.prepare(1), original = f.respond;
    f.setRespond((method, params) => method === 'Runtime.evaluate' ? pending.promise : original(method, params));
    f.emit('browser.eval.execute', f.execution(fence)); await until(() => f.client.commands.some(command => command.method === 'Runtime.evaluate'));
    for (let id = 2; id <= 6; id++) f.emit('browser.execute', f.read(id));
    await until(() => f.replies.length === 1); assert.match(JSON.stringify(f.replies[0].result), /browser_busy/); assert.equal(f.captures, 0);
    f.controller.stopAgentOperation('source', fence.operationId); await until(() => f.replies.length === 2); assert.equal(f.captures, 0);
    pending.resolve({ result: { type: 'undefined' } }); await until(() => f.replies.length === 6); assert.equal(f.captures, 4);
    const state = f.controller.state('source'); assert.equal(isBrowserSharingState(state), true); assert.equal(state.operations?.length, 5);
    assert.equal(state.operations?.some(operation => operation.tool === ('browser_eval' as any)), false);
  } finally { pending.resolve({}); f.dispose(); }
});

test('Off confirms unregister without waiting for possible eval effects and fresh Read still waits for native settlement', async () => {
  const f = fixture(), pending = deferred();
  try {
    await f.share(); const old = f.target(), fence = await f.prepare(1), original = f.respond;
    f.setRespond((method, params) => method === 'Runtime.evaluate' ? pending.promise : original(method, params));
    f.emit('browser.eval.execute', f.execution(fence)); await until(() => f.client.commands.some(command => command.method === 'Runtime.evaluate'));
    await f.controller.share({ type: 'share', tabId: 'source', level: 'off' }); assert.equal(f.controller.state('source').level, 'off');
    assert.ok(f.calls.some(call => call.method === 'browser.unregisterTab' && call.params.tabId === old.tabId));
    await f.share('read'); assert.notEqual(f.target().tabId, old.tabId); f.emit('browser.execute', f.read(2)); await turn(); assert.equal(f.captures, 0);
    pending.resolve({ result: { type: 'string', value: 'must-not-return' } }); await until(() => f.replies.length === 2); assert.equal(f.captures, 1);
    assert.doesNotMatch(JSON.stringify(f.replies), /must-not-return/);
  } finally { pending.resolve({}); f.dispose(); }
});

test('external detach keeps a quarantined lane blocked until the exact destroyed-native hook', async () => {
  const f = fixture();
  try {
    await f.share(); const fence = await f.prepare(1), original = f.respond;
    f.setRespond((method, params) => method === 'Runtime.evaluate' ? new Promise(() => undefined) : original(method, params));
    f.emit('browser.eval.execute', f.execution(fence)); await until(() => f.client.commands.some(command => command.method === 'Runtime.evaluate'));
    f.client.emit('detach', {}, 'external'); f.client.attached = true; await until(() => f.replies.length === 1);
    f.emit('browser.execute', f.read(2)); f.controller.nativeDestroyed(f.contents); await turn(); assert.equal(f.captures, 0); assert.equal(f.replies.length, 1);
    f.setDestroyed(true); f.controller.nativeDestroyed(f.contents); await until(() => f.replies.length === 2); assert.equal(f.captures, 0);
  } finally { f.setDestroyed(true); f.controller.nativeDestroyed(f.contents); f.dispose(); }
});

test('Control fences admit Read and downgrade/Off/cross-origin retire prior authority', () => {
  const grants = new BrowserAgentGrants(), registration = { tabId: 'opaque', sourceTabId: 'source', attachmentId: 'attachment', attachmentGeneration: 1, runtimeEpoch: 'epoch', viewGeneration: 1 };
  const document = { sourceTabId: 'source', viewGeneration: 1, documentGeneration: 1, navigationEpoch: 1, url: 'https://page.test/', available: true, loaded: true };
  const state = grants.register(registration); grants.setShare('source', 'control', { ...document, grantEpoch: state.grantEpoch }, document);
  const control = grants.captureControl('source', document), read = grants.captureRead('source', document); grants.assertRead(read, document);
  grants.downgradeToRead('source'); assert.equal(grants.state('source')?.level, 'read'); assert.throws(() => grants.assertControl(control, document)); assert.throws(() => grants.assertRead(read, document));
  const current = grants.captureRead('source', document); grants.assertRead(current, document);
  grants.navigationStarted('source', 'https://foreign.test/'); assert.equal(grants.state('source')?.level, 'off'); assert.throws(() => grants.assertRead(current, document));
});
