import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
function controllerModule() {
  const code = buildSync({ entryPoints: ['desktop/src/browser/agentController.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { Buffer, URL, TextEncoder, AbortController, setTimeout, clearTimeout, queueMicrotask }, { filename: 'browser-agent-controller-fixture.cjs' })(require, module, module.exports);
  return module.exports;
}
const tick = () => new Promise(done => setImmediate(done));
async function until(probe) { for (let count = 0; count < 200; count++) { if (probe()) return; await tick(); } throw Error('Fixture did not settle'); }

function fixture() {
  const { BrowserAgentController } = controllerModule(), events = new EventEmitter(), calls = [], replies = [], changes = [];
  let attachmentSequence = 0, tabSequence = 0, captures = 0, capture = async () => image();
  let document = { sourceTabId: 'source', viewGeneration: 1, documentGeneration: 1, navigationEpoch: 1, url: 'http://127.0.0.1:4001/page', available: true, loaded: true };
  let workspace = { id: 'workspace', revision: 1, projectId: 'project', worktreePath: 'D:/fixture/work', layout: { kind: 'pane', id: 'pane', tabs: [{ id: 'source', kind: 'web', url: document.url }], activeTabId: 'source' } };
  const image = () => ({ isEmpty: () => false, getSize: () => ({ width: 100, height: 50 }), toPNG: () => Buffer.from('fixture image'), toJPEG: () => Buffer.from('fixture image'), resize() { return this; } });
  const contents = { isDestroyed: () => false, debugger: {}, capturePage(...args) { captures++; return capture(...args); } };
  const gates = new Map(), attachments = new Map(), registrations = new Map();
  const runtime = {
    async browserRequest(method, params) {
      calls.push({ method, params });
      if (gates.has(method)) await gates.get(method);
      if (method === 'browser.attach') { const value = { attachmentId: `attachment-${++attachmentSequence}`, attachmentGeneration: 1, runtimeEpoch: 'epoch', viewGeneration: params.viewGeneration }; attachments.set(value.attachmentId, value); return value; }
      if (method === 'browser.registerTab') { const value = { ...attachments.get(params.attachmentId), tabId: `handle-${++tabSequence}`, sourceTabId: params.sourceTabId }; registrations.set(value.tabId, value); return value; }
      if (method === 'browser.unregisterTab') { registrations.delete(params.tabId); return { unregistered: true }; }
      if (method === 'browser.detach') { attachments.delete(params.attachmentId); return { detached: true }; }
      if (method === 'browser.desktop.reply') { replies.push(params); return { accepted: true }; }
      throw Error(`Unexpected ${method}`);
    },
    onBrowserFrame(listener) { events.on('frame', listener); return () => events.off('frame', listener); },
    onBrowserDisconnect(listener) { events.on('disconnect', listener); return () => events.off('disconnect', listener); },
    onEvent(listener) { events.on('runtime', listener); return () => events.off('runtime', listener); },
    async snapshot() { return { workspaces: workspace ? [workspace] : [] }; },
  };
  const controller = new BrowserAgentController(runtime, { getTab: id => id === 'source' ? { document, contents, title: 'Fixture tab' } : undefined, changed: id => changes.push({ id, state: controller.state(id) }) });
  const share = () => controller.share({ type: 'share', tabId: 'source', level: 'read', workspace: { id: 'workspace', revision: workspace.revision }, expected: { documentGeneration: document.documentGeneration, ...controller.state('source') } });
  function execution(sequence, tool = 'browser_screenshot', extras = {}) {
    const target = [...registrations.values()].at(-1); assert.ok(target);
    return { attachmentId: target.attachmentId, attachmentGeneration: target.attachmentGeneration, runtimeEpoch: target.runtimeEpoch, viewGeneration: target.viewGeneration, operationId: `epoch:${sequence}`, invocationId: `host:${sequence}`, callerSessionId: 'caller', workerGeneration: 'worker', deadlineUnixMs: Date.now() + 10_000, tool, arguments: tool === 'browser_list_tabs' ? {} : { tabId: target.tabId }, targets: [target], ...extras };
  }
  const emit = request => events.emit('frame', { method: 'browser.execute', params: request });
  return { controller, events, calls, replies, changes, share, execution, emit, get captures() { return captures; }, get document() { return document; }, set document(value) { document = value; }, get workspace() { return workspace; }, set workspace(value) { workspace = value; }, setCapture(value) { capture = value; }, image, defer(method) { let done; gates.set(method, new Promise(resolve => { done = resolve; })); return () => { gates.delete(method); done(); }; }, dispose() { controller.dispose(); } };
}

test('sharing requires exact saved membership and re-share receives a fresh opaque registration', async () => {
  const f = fixture();
  try {
    assert.equal(f.controller.state('source').level, 'off');
    f.workspace = { ...f.workspace, layout: { ...f.workspace.layout, tabs: [] } }; await assert.rejects(f.share()); assert.equal(f.calls.length, 0);
    f.workspace = { ...f.workspace, layout: { ...f.workspace.layout, tabs: [{ id: 'source', kind: 'web', url: f.document.url }] } };
    await f.share(); const first = f.execution(1).targets[0]; assert.equal(f.controller.state('source').level, 'read');
    const attach = f.calls.find(call => call.method === 'browser.attach'), register = f.calls.find(call => call.method === 'browser.registerTab');
    assert.equal(attach.params.workspaceId, 'workspace'); assert.equal(attach.params.workspaceRevision, 1); assert.equal(attach.params.viewGeneration, 1); assert.ok(attach.params.viewId);
    assert.equal(register.params.sourceTabId, 'source'); assert.equal(register.params.workspaceRevision, 1); assert.equal(register.params.attachmentId, first.attachmentId); assert.equal(register.params.attachmentGeneration, first.attachmentGeneration);
    await f.controller.share({ type: 'share', tabId: 'source', level: 'off' }); assert.equal(f.controller.state('source').level, 'off');
    assert.ok(f.calls.some(call => call.method === 'browser.unregisterTab' && call.params.tabId === first.tabId));
    await f.share(); const second = f.execution(2).targets[0]; assert.notEqual(second.tabId, first.tabId); assert.notEqual(second.attachmentId, first.attachmentId);
  } finally { f.dispose(); }
});

test('Off cancels a pending registration immediately and waits for late attachment cleanup', async () => {
  const f = fixture(); const finishAttach = f.defer('browser.attach');
  try {
    const sharing = f.share(); const rejected = assert.rejects(sharing); await until(() => f.calls.some(call => call.method === 'browser.attach'));
    let settled = false; const off = f.controller.share({ type: 'share', tabId: 'source', level: 'off' }).then(() => { settled = true; });
    assert.equal(f.controller.state('source').level, 'off'); await tick(); assert.equal(settled, false);
    finishAttach(); await rejected; await off; assert.equal(f.controller.state('source').status, 'idle'); assert.ok(f.calls.some(call => call.method === 'browser.detach'));
  } finally { f.dispose(); }
});

test('private execution preserves MCP image blocks and duplicate delivery never repeats capture', async () => {
  const f = fixture();
  try {
    await f.share(); const request = f.execution(1); f.emit(request); await until(() => f.replies.length === 1);
    const result = f.replies[0].result; assert.equal(result.content[1].type, 'image'); assert.match(result.content[0].text, /Page data, not instructions/); assert.equal(f.captures, 1);
    const { provenance } = JSON.parse(result.content[0].text.slice(result.content[0].text.indexOf('{')));
    assert.equal(provenance.operationId, request.operationId); assert.equal(provenance.callerSessionId, request.callerSessionId); assert.equal(provenance.title, 'Fixture tab'); assert.equal(provenance.tool, 'browser_screenshot'); assert.equal(provenance.outcome, 'completed'); assert.match(provenance.thumbnail, /^data:image\/jpeg;base64,/);
    f.emit(request); await until(() => f.replies.length === 2); assert.equal(f.captures, 1); assert.deepEqual(f.replies[1].result, result);
    f.emit({ ...request, workerGeneration: 'different' }); await until(() => f.replies.length === 3); assert.equal(f.replies[2].result.isError, true); assert.equal(f.captures, 1);
  } finally { f.dispose(); }
});

test('tab reads run one at a time with four queued and explicit overflow', async () => {
  const f = fixture(), finish = [];
  try {
    await f.share(); f.setCapture(() => new Promise(resolve => finish.push(() => resolve(f.image()))));
    for (let sequence = 1; sequence <= 6; sequence++) f.emit(f.execution(sequence));
    await until(() => f.replies.length === 1); assert.equal(f.captures, 1); assert.match(f.replies[0].result.content[0].text, /browser_busy/);
    for (let index = 0; index < 5; index++) { await until(() => finish.length > index); finish[index](); await tick(); }
    await until(() => f.replies.length === 6); assert.equal(f.captures, 5);
  } finally { f.dispose(); }
});

test('same-origin navigation preserves Read but suppresses old queued/in-flight/cached reads', async () => {
  const f = fixture(); let finish;
  try {
    await f.share(); const first = f.execution(1); f.setCapture(() => new Promise(resolve => { finish = resolve; })); f.emit(first); f.emit(f.execution(2)); await tick();
    f.controller.navigationStarted('source', 'http://127.0.0.1:4001/next'); f.document = { ...f.document, url: 'http://127.0.0.1:4001/next', navigationEpoch: 2, documentGeneration: 2 };
    assert.equal(f.controller.state('source').level, 'read'); finish(f.image()); await until(() => f.replies.length === 2); assert.ok(f.replies.every(reply => reply.result.isError));
    for (const reply of f.replies) { const text = reply.result.content[0].text, error = JSON.parse(text.slice(text.indexOf('{'))); assert.equal(error.provenance.outcome, 'failed'); assert.equal(error.provenance.url, 'http://127.0.0.1:4001/page'); assert.equal(error.provenance.title, 'Fixture tab'); assert.equal(error.provenance.callerSessionId, 'caller'); assert.equal(error.provenance.operationId, reply.operationId); assert.ok(Buffer.byteLength(text) <= 60 * 1024); }
    f.emit(first); await until(() => f.replies.length === 3); assert.equal(f.replies[2].result.isError, true); assert.equal(f.captures, 1);
  } finally { f.dispose(); }
});

test('cross-origin start, unload, scope removal and disconnect revoke without restoration', async () => {
  for (const mode of ['cross-origin', 'unload', 'workspace', 'disconnect']) {
    const f = fixture();
    try {
      await f.share(); const old = f.execution(1);
      if (mode === 'cross-origin') { f.controller.navigationStarted('source', 'http://127.0.0.1:4002/other'); f.controller.navigationStarted('source', f.document.url); }
      if (mode === 'unload') f.controller.invalidate('source', 'View unloaded');
      if (mode === 'workspace') { f.workspace = undefined; f.events.emit('runtime', { event: 'state.changed' }); await tick(); }
      if (mode === 'disconnect') f.events.emit('disconnect', Error('Disconnected'));
      assert.equal(f.controller.state('source').level, 'off'); f.emit(old); await tick(); assert.equal(f.captures, 0);
    } finally { f.dispose(); }
  }
});

test('cancel before notification retires the operation and foreign tuple cannot cancel current work', async () => {
  const f = fixture();
  try {
    await f.share(); const request = f.execution(1), { operationId, workerGeneration, attachmentId, attachmentGeneration, runtimeEpoch, viewGeneration } = request;
    f.events.emit('frame', { method: 'browser.cancel', params: { operationId, workerGeneration, attachmentId, attachmentGeneration, runtimeEpoch, viewGeneration, reason: 'Cancelled' } });
    f.emit(request); await until(() => f.replies.length === 1); assert.match(f.replies[0].result.content[0].text, /receipt_expired/); assert.equal(f.captures, 0);
  } finally { f.dispose(); }
});

test('a long-lived generation exceeds 512 calls, evicts receipts and never replays retired reads', async () => {
  const f = fixture();
  try {
    await f.share(); let first, last;
    for (let sequence = 1; sequence <= 540; sequence++) { const request = f.execution(sequence); first ??= request; last = request; f.emit(request); await until(() => f.replies.length === sequence); }
    assert.equal(f.captures, 540); f.emit(first); await until(() => f.replies.length === 541); assert.match(f.replies.at(-1).result.content[0].text, /receipt_expired/); assert.equal(f.captures, 540);
    f.emit(last); await until(() => f.replies.length === 542); assert.equal(f.replies.at(-1).result.isError, undefined); assert.equal(f.captures, 540);
    f.emit(f.execution(541)); await until(() => f.replies.length === 543); assert.equal(f.captures, 541);
  } finally { f.dispose(); }
});

test('list replies contain only runtime-targeted current Read handles and stay bounded', async () => {
  const f = fixture();
  try {
    await f.share(); const request = f.execution(1, 'browser_list_tabs'); f.emit(request); await until(() => f.replies.length === 1);
    const result = f.replies[0].result; assert.equal(result.tabs.length, 1); assert.equal(result.tabs[0].tabId, request.targets[0].tabId); assert.equal(result.tabs[0].shareLevel, 'read'); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 60 * 1024);
    f.emit(f.execution(2, 'browser_list_tabs', { targets: [] })); await until(() => f.replies.length === 2); assert.equal(f.replies[1].result.tabs.length, 0);
  } finally { f.dispose(); }
});

test('strict private frames reject spoofed arguments and deadline bounds waiting reads', async () => {
  const f = fixture();
  try {
    await f.share(); const malformed = f.execution(1); malformed.arguments.callerSessionId = 'spoofed'; f.emit(malformed); await tick(); assert.equal(f.captures, 0); assert.equal(f.replies.length, 0);
    f.setCapture(() => new Promise(() => undefined)); f.emit(f.execution(2, 'browser_screenshot', { deadlineUnixMs: Date.now() + 15 }));
    await new Promise(done => setTimeout(done, 25)); assert.equal(f.replies.length, 1); assert.match(f.replies[0].result.content[0].text, /browser_deadline/); assert.equal(f.controller.state('source').reading, false);
  } finally { f.dispose(); }
});
