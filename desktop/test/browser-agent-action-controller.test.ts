import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { BrowserAgentController } from '../src/browser/agentController.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const pause = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
async function until(probe: () => boolean) { for (let index = 0; index < 400; index++) { if (probe()) return; await turn(); } throw new Error('Fixture did not settle'); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

function fixture() {
  const events = new EventEmitter(), calls: any[] = [], replies: any[] = [], registrations = new Map<string, any>(), attachments = new Map<string, any>();
  const dispatched = new Set<string>(), cancelledByUnregister = new Set<string>();
  let sequence = 0, captures = 0, destroyed = false, navigationCalls = 0;
  let replyGate: Promise<void> | undefined;
  let document = { sourceTabId: 'source', viewGeneration: 1, documentGeneration: 1, navigationEpoch: 1, url: 'http://127.0.0.1:4001/page', available: true, loaded: true };
  const workspace = { id: 'workspace', revision: 1, projectId: 'project', worktreePath: 'D:/fixture/work', layout: { kind: 'pane', id: 'pane', tabs: [{ id: 'source', kind: 'web', url: document.url }], activeTabId: 'source' } };
  class Debugger extends EventEmitter {
    attached = false;
    isAttached() { return this.attached; }
    attach() { this.attached = true; }
    detach() { this.attached = false; this.emit('detach', {}, 'owned cleanup'); }
    async sendCommand(method: string) {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'loader', url: document.url, securityOrigin: 'http://127.0.0.1:4001' } } };
      return {};
    }
  }
  const client = new Debugger();
  const image = { isEmpty: () => false, getSize: () => ({ width: 100, height: 50 }), toPNG: () => Buffer.from('image'), toJPEG: () => Buffer.from('image'), resize() { return this; } };
  const contents = { debugger: client, isDestroyed: () => destroyed, capturePage: async () => { captures++; return image; } };
  const runtime = {
    async browserRequest(method: string, params: any) {
      calls.push({ method, params });
      if (method === 'browser.attach') { const attachment = { attachmentId: `attachment-${++sequence}`, attachmentGeneration: 1, runtimeEpoch: 'epoch', viewGeneration: params.viewGeneration }; attachments.set(attachment.attachmentId, attachment); return attachment; }
      if (method === 'browser.registerTab') { const registration = { ...attachments.get(params.attachmentId), sourceTabId: params.sourceTabId, tabId: `handle-${sequence}` }; registrations.set(registration.tabId, registration); return registration; }
      if (method === 'browser.desktop.dispatch') { dispatched.add(params.operationId); return { accepted: true }; }
      if (method === 'browser.unregisterTab') { for (const operationId of dispatched) cancelledByUnregister.add(operationId); registrations.delete(params.tabId); return { unregistered: true }; }
      if (method === 'browser.detach') return { detached: true };
      if (method === 'browser.desktop.reply') {
        await replyGate;
        if (cancelledByUnregister.has(params.operationId)) throw new Error('runtime cancelled the pending action before its receipt');
        replies.push(params); dispatched.delete(params.operationId); return { accepted: true };
      }
      return { accepted: true };
    },
    onBrowserFrame(fn: any) { events.on('frame', fn); return () => events.off('frame', fn); },
    onBrowserDisconnect(fn: any) { events.on('disconnect', fn); return () => events.off('disconnect', fn); },
    onEvent(fn: any) { events.on('event', fn); return () => events.off('event', fn); },
    async snapshot() { return { workspaces: [workspace] as any }; },
  };
  let controller!: BrowserAgentController;
  let navigate = async (_id: string, _url: string): Promise<{ sharingRevoked: boolean }> => ({ sharingRevoked: false });
  controller = new BrowserAgentController(runtime, {
    getTab: id => id === 'source' && !destroyed ? { document, contents, title: 'Fixture title' } : undefined,
    changed: () => undefined,
    electronVersion: '44.3.0',
    actionCapability: () => true,
    canControl: () => true,
    navigate: async (id, url) => { navigationCalls++; return navigate(id, url); },
  });
  const share = () => controller.share({ type: 'share', tabId: 'source', level: 'control', workspace: { id: 'workspace', revision: 1, sessionId: 'approved-session' } as any, expected: { documentGeneration: document.documentGeneration, ...controller.state('source') } });
  const target = () => [...registrations.values()].at(-1);
  const envelope = (id: number) => { const { tabId: _tabId, sourceTabId: _source, ...attachment } = target(); return { ...attachment, operationId: `epoch:${id}`, workerGeneration: 'worker', invocationId: `host:${id}`, callerSessionId: 'caller' }; };
  const action = (id: number, deadlineUnixMs = Date.now() + 10_000) => ({ ...envelope(id), deadlineUnixMs, tool: 'browser_navigate', arguments: { tabId: target().tabId, url: `http://127.0.0.1:4001/page-${id}` }, targets: [target()] });
  const screenshot = (id: number) => ({ ...envelope(id), deadlineUnixMs: Date.now() + 10_000, tool: 'browser_screenshot', arguments: { tabId: target().tabId }, targets: [target()] });
  const emit = (method: string, params: any) => events.emit('frame', { method, params });
  return {
    controller, calls, replies, share, action, screenshot, emit,
    setNavigate(value: typeof navigate) { navigate = value; },
    setReplyGate(value?: Promise<void>) { replyGate = value; },
    get captures() { return captures; }, get navigationCalls() { return navigationCalls; },
    disconnect() { events.emit('disconnect'); },
    setDestroyed(value: boolean) { destroyed = value; },
    dispose() { controller.dispose(); },
  };
}

test('runtime clear keeps a native action lane latched only until its real settlement', async () => {
  const f = fixture(), navigation = deferred<{ sharingRevoked: boolean }>();
  try {
    f.setNavigate(() => navigation.promise);
    await f.share(); f.emit('browser.execute', f.action(1)); await until(() => f.navigationCalls === 1);
    f.disconnect(); await f.share(); f.emit('browser.execute', f.screenshot(2)); await turn();
    assert.equal(f.captures, 0, 'the replacement read must not overlap an unsettled native action');
    navigation.resolve({ sharingRevoked: false });
    await until(() => f.captures === 1 && f.replies.some(reply => reply.operationId === 'epoch:2'));
    assert.equal(f.replies.some(reply => reply.operationId === 'epoch:1'), false, 'a cleared broker operation is not replayed locally');
  } finally { navigation.resolve({ sharingRevoked: false }); f.dispose(); }
});

test('admitted navigation returns one completed receipt and revokes the exact grant', async () => {
  const f = fixture();
  try {
    f.setNavigate(async id => { f.controller.navigationAdmitted(id); return { sharingRevoked: true }; });
    await f.share(); const request = f.action(1); f.emit('browser.execute', request);
    await until(() => f.replies.length === 1);
    assert.deepEqual(f.replies[0].result.navigation, { admitted: true, sharingRevoked: true });
    assert.equal(f.replies[0].result.outcome, 'completed');
    assert.equal(f.controller.state('source').level, 'off');
    await until(() => f.calls.some(call => call.method === 'browser.unregisterTab'));
    const replyAt = f.calls.findIndex(call => call.method === 'browser.desktop.reply' && call.params.operationId === request.operationId);
    const unregisterAt = f.calls.findIndex(call => call.method === 'browser.unregisterTab');
    assert.ok(replyAt >= 0 && unregisterAt > replyAt, 'the accepted navigation receipt must reach runtime before unregister');
  } finally { f.dispose(); }
});

test('a queued action whose deadline expires receives a deadline receipt without dispatch', async () => {
  const f = fixture(), navigation = deferred<{ sharingRevoked: boolean }>();
  try {
    f.setNavigate(() => navigation.promise);
    await f.share(); f.emit('browser.execute', f.action(1)); await until(() => f.navigationCalls === 1);
    const expiring = f.action(2, Date.now() + 30); f.emit('browser.execute', expiring); await pause(60);
    await until(() => f.replies.some(reply => reply.operationId === expiring.operationId));
    const receipt = f.replies.find(reply => reply.operationId === expiring.operationId).result;
    assert.deepEqual(receipt, { outcome: 'failed', code: 'browser_deadline' });
    assert.equal(f.navigationCalls, 1, 'the expired queued action never reaches the native host');
  } finally { navigation.resolve({ sharingRevoked: false }); f.dispose(); }
});

test('an exact completed navigation duplicate replays its receipt after grant revocation', async () => {
  const f = fixture();
  try {
    f.setNavigate(async id => { f.controller.navigationAdmitted(id); return { sharingRevoked: true }; });
    await f.share(); const request = f.action(1); f.emit('browser.execute', request); await until(() => f.replies.length === 1);
    const first = structuredClone(f.replies[0].result); f.emit('browser.execute', request); await until(() => f.replies.length === 2);
    assert.deepEqual(f.replies[1].result, first); assert.equal(f.navigationCalls, 1);
  } finally { f.dispose(); }
});

test('dispose flushes a held navigation registration while its reply is still pending', async () => {
  const f = fixture(), reply = deferred<void>();
  try {
    f.setReplyGate(reply.promise);
    f.setNavigate(async id => { f.controller.navigationAdmitted(id); return { sharingRevoked: true }; });
    await f.share(); const request = f.action(1); f.emit('browser.execute', request);
    await until(() => f.calls.some(call => call.method === 'browser.desktop.reply' && call.params.operationId === request.operationId));
    assert.equal(f.calls.some(call => call.method === 'browser.unregisterTab'), false, 'normal navigation cleanup waits for its reply');
    f.dispose();
    await until(() => f.calls.some(call => call.method === 'browser.unregisterTab') && f.calls.some(call => call.method === 'browser.detach'));
    assert.equal(f.replies.length, 0, 'dispose does not fabricate acceptance for the pending reply');
  } finally { reply.resolve(); f.setReplyGate(); f.dispose(); }
});

test('post-dispatch Stop stays outcome-unknown in activity and a later Stop cannot relabel it', async () => {
  const f = fixture(), navigation = deferred<{ sharingRevoked: boolean }>();
  try {
    f.setNavigate(() => navigation.promise);
    await f.share(); const request = f.action(1); f.emit('browser.execute', request); await until(() => f.navigationCalls === 1);
    f.controller.stopAgentOperation('source', request.operationId); await until(() => f.replies.length === 1);
    assert.deepEqual(f.replies[0].result, { outcome: 'outcome_unknown', code: 'browser_outcome_unknown', source: { title: 'Fixture title', url: 'http://127.0.0.1:4001/page', origin: 'http://127.0.0.1:4001' } });
    assert.equal(f.controller.state('source').operations?.find(operation => operation.operationId === request.operationId)?.phase, 'outcome_unknown');
    f.controller.stopAgentOperation('source', request.operationId);
    assert.equal(f.controller.state('source').operations?.find(operation => operation.operationId === request.operationId)?.phase, 'outcome_unknown');
  } finally { navigation.resolve({ sharingRevoked: false }); f.dispose(); }
});
