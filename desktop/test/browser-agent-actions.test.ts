import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { BrowserExecution } from '@threadterm/protocol';
import { BrowserAgentActions, type BrowserAgentActionContext } from '../src/browser/agentActions.js';

const deferred = <T = unknown>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
type Request = Pick<BrowserExecution, 'tool' | 'arguments' | 'deadlineUnixMs'>;

function fixture() {
  const registration = { tabId: 'opaque-tab', sourceTabId: 'native-tab', attachmentId: 'attachment', attachmentGeneration: 1, runtimeEpoch: 'runtime', viewGeneration: 2 };
  const fence = { registration, level: 'control' as const, grantEpoch: 3, refGeneration: 4, documentGeneration: 5, navigationEpoch: 6, origin: 'https://page.test', url: 'https://page.test/path' };
  let document = { sourceTabId: 'native-tab', viewGeneration: 2, documentGeneration: 5, navigationEpoch: 6, url: fence.url, loaded: true, available: true, appOrigin: 'https://app.test' };
  let available = true, authorized = true, destroyed = false, loaderId = 'loader';
  let state = { connected: true, visible: true, disabled: false, readOnly: false, tag: 'button', type: 'button', editable: false, focusable: true, select: false };
  const order: string[] = [];
  let respond: (method: string, params?: Record<string, unknown>) => Promise<unknown> = async (method, params) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame', loaderId, url: document.url, securityOrigin: fence.origin } } };
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 17, frameId: 'main-frame' } };
    if (method === 'DOM.getBoxModel') return { model: { border: [10, 20, 30, 20, 30, 40, 10, 40] } };
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 17, frameId: 'main-frame' };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'object-17' } };
    if (method === 'Runtime.callFunctionOn') {
      const source = String(params?.functionDeclaration ?? '');
      if (source.includes('getComputedStyle')) return { result: { value: state } };
      return { result: { value: true } };
    }
    return {};
  };
  class Debugger extends EventEmitter {
    attached = false; attaches = 0; detaches = 0; commands: { method: string; params?: Record<string, unknown> }[] = [];
    isAttached() { return this.attached; }
    attach() { if (this.attached) throw new Error('conflict'); this.attached = true; this.attaches++; }
    detach() { this.attached = false; this.detaches++; this.emit('detach', {}, 'owned cleanup'); }
    sendCommand(method: string, params?: Record<string, unknown>) { order.push(method); this.commands.push({ method, params }); return respond(method, params); }
  }
  const client = new Debugger();
  const contents = { isDestroyed: () => destroyed, debugger: client, capturePage: async (): Promise<never> => { throw new Error('not used'); } };
  const signal = new AbortController();
  let dispatches = 0, navigated: string | undefined;
  let api: BrowserAgentActions;
  const context: BrowserAgentActionContext = {
    fence, source: { title: 'Fixture', url: fence.url, origin: fence.origin }, signal: signal.signal,
    getTab: () => ({ contents, document }),
    resolveRef: ref => { if (ref !== 'exact-ref') throw Object.assign(new Error('stale'), { code: 'browser_stale_ref' }); return { ref, backendNodeId: 17, axNodeId: 'ax-17', frameId: 'main-frame', role: 'button' }; },
    assertAuthorized: () => { if (!authorized) throw Object.assign(new Error('denied'), { code: 'browser_grant_required' }); },
    beforeDispatch: async () => { dispatches++; order.push('ACK'); },
    navigate: async url => { navigated = url; api.invalidate('native-tab'); return { sharingRevoked: true }; },
  };
  api = new BrowserAgentActions({ electronVersion: '44.3.0', available: () => available });
  const request = (tool: Request['tool'], args: Record<string, unknown> = {}): Request => ({ tool, arguments: { tabId: registration.tabId, ...(tool === 'browser_navigate' ? { url: 'https://next.test/path' } : { ref: 'exact-ref' }), ...args }, deadlineUnixMs: Date.now() + 10_000 });
  const execute = async (value: Request) => { const ticket = api.execute(value, context), result = await ticket.result; await ticket.settled; return result; };
  return { api, client, contents, context, signal, order, request, execute,
    get state() { return state; }, get document() { return document; }, get dispatches() { return dispatches; }, get navigated() { return navigated; }, get respond() { return respond; },
    setState(value: typeof state) { state = value; }, setDocument(value: typeof document) { document = value; }, setRespond(value: typeof respond) { respond = value; },
    setAvailable(value: boolean) { available = value; }, setAuthorized(value: boolean) { authorized = value; }, setDestroyed(value: boolean) { destroyed = value; }, setLoader(value: string) { loaderId = value; },
  };
}

test('six ordinary tools use fixed native adapters only after authenticated admission', async () => {
  const cases: { tool: Request['tool']; args?: Record<string, unknown>; mutation: string }[] = [
    { tool: 'browser_click', mutation: 'Input.dispatchMouseEvent' },
    { tool: 'browser_hover', mutation: 'Input.dispatchMouseEvent' },
    { tool: 'browser_type', args: { text: 'user text ` ${not-code}' }, mutation: 'Input.insertText' },
    { tool: 'browser_press_key', args: { key: 'Enter' }, mutation: 'DOM.focus' },
    { tool: 'browser_select_option', args: { values: ['one', 'two'] }, mutation: 'Runtime.callFunctionOn' },
  ];
  for (const item of cases) {
    const f = fixture();
    if (item.tool === 'browser_type') f.setState({ ...f.state, tag: 'input', type: 'text', editable: true });
    if (item.tool === 'browser_select_option') f.setState({ ...f.state, tag: 'select', type: '', select: true });
    const result = await f.execute(f.request(item.tool, item.args));
    assert.deepEqual(result, { outcome: 'completed', source: f.context.source });
    const ack = f.order.indexOf('ACK');
    const mutation = item.tool === 'browser_select_option' ? f.order.findIndex((entry, index) => index > ack && entry === item.mutation) : f.order.indexOf(item.mutation);
    assert.ok(ack >= 0 && mutation > ack, `${item.tool} must mutate after ACK`);
    assert.equal(f.dispatches, 1); assert.equal(f.client.detaches, 1);
    if (item.tool === 'browser_type') {
      assert.equal(f.client.commands.find(command => command.method === 'Input.insertText')?.params?.text, 'user text ` ${not-code}');
      assert.equal(f.client.commands.some(command => String(command.params?.functionDeclaration ?? '').includes('user text')), false);
    }
  }
  const f = fixture(), result = await f.execute(f.request('browser_navigate'));
  assert.deepEqual(result, { outcome: 'completed', source: f.context.source, navigation: { admitted: true, sharingRevoked: true } });
  assert.equal(f.navigated, 'https://next.test/path'); assert.equal(f.client.commands.some(command => command.method.startsWith('DOM.')), false);
});

test('owned debugger cleanup after a successful mutation settles without native destruction', async () => {
  const f = fixture(), ticket = f.api.execute(f.request('browser_hover'), f.context);
  assert.equal((await ticket.result).outcome, 'completed');
  await ticket.settled;
  assert.equal(f.api.isBusy(f.contents), false); assert.equal(f.client.detaches, 1); assert.equal(f.contents.isDestroyed(), false);
});

test('denial, stale refs and obscured or disabled targets fail before native mutation', async () => {
  const denied = fixture(); denied.setAuthorized(false);
  assert.equal((await denied.execute(denied.request('browser_click'))).code, 'browser_control_required'); assert.equal(denied.client.attaches, 0);
  const stale = fixture();
  assert.equal((await stale.execute(stale.request('browser_click', { ref: 'retired-ref' }))).code, 'browser_stale_ref');
  assert.equal(stale.client.commands.some(command => command.method.startsWith('Input.')), false); assert.equal(stale.dispatches, 0);
  for (const change of [{ visible: false }, { disabled: true }]) {
    const f = fixture(); f.setState({ ...f.state, ...change }); const result = await f.execute(f.request('browser_click'));
    assert.equal(result.outcome, 'failed'); assert.equal(f.dispatches, 0); assert.equal(f.client.commands.some(command => command.method.startsWith('Input.')), false);
  }
  const obscured = fixture(), original = obscured.respond;
  obscured.setRespond((method, params) => method === 'DOM.getNodeForLocation' ? Promise.resolve({ backendNodeId: 99, frameId: 'main-frame' }) : original(method, params));
  assert.equal((await obscured.execute(obscured.request('browser_click'))).outcome, 'failed'); assert.equal(obscured.dispatches, 0);
});

test('dispatch ACK rejection is no-replay uncertainty and performs no mutation', async () => {
  const f = fixture(); f.context.beforeDispatch = async () => { throw new Error('transport detail'); };
  const result = await f.execute(f.request('browser_click'));
  assert.deepEqual(result, { outcome: 'outcome_unknown', code: 'browser_outcome_unknown', source: f.context.source });
  assert.equal(f.client.commands.some(command => command.method.startsWith('Input.')), false);
});

test('navigation rejects credentials before admission and expected grant invalidation preserves admission receipt', async () => {
  const f = fixture();
  const rejected = await f.execute(f.request('browser_navigate', { url: 'https://user:secret@next.test/' }));
  assert.equal(rejected.outcome, 'failed'); assert.equal(f.dispatches, 0); assert.equal(f.navigated, undefined);
  const g = fixture(), result = await g.execute(g.request('browser_navigate', { url: 'https://next.test/a/../b' }));
  assert.equal(result.outcome, 'completed'); assert.equal(result.navigation?.sharingRevoked, true); assert.equal(g.navigated, 'https://next.test/b');
});

test('navigation rechecks native top-document identity after dispatch ACK before host admission', async () => {
  const f = fixture(); f.context.beforeDispatch = async () => { f.setLoader('new-loader'); };
  const result = await f.execute(f.request('browser_navigate'));
  assert.equal(result.outcome, 'outcome_unknown'); assert.equal(result.code, 'browser_outcome_unknown'); assert.equal(f.navigated, undefined);
});

test('cancellation returns uncertainty but keeps the lane until the issued native promise settles', async () => {
  const f = fixture(), pending = deferred(), original = f.respond;
  f.setState({ ...f.state, tag: 'input', type: 'text', editable: true });
  f.setRespond((method, params) => method === 'Input.insertText' ? pending.promise : original(method, params));
  const ticket = f.api.execute(f.request('browser_type', { text: 'held' }), f.context); await turn();
  let settled = false; void ticket.settled.then(() => { settled = true; });
  f.signal.abort(); const result = await ticket.result;
  assert.equal(result.outcome, 'outcome_unknown'); assert.equal(f.api.isBusy(f.contents), true); assert.equal(settled, false);
  pending.resolve({}); await ticket.settled; assert.equal(f.api.isBusy(f.contents), false); assert.equal(settled, true);
});

test('cancellation between native steps prevents every later mutation', async () => {
  const click = fixture(), clickRespond = click.respond;
  click.setRespond(async (method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseMoved') { click.signal.abort(); return {}; }
    return clickRespond(method, params);
  });
  assert.equal((await click.execute(click.request('browser_click'))).outcome, 'outcome_unknown');
  assert.equal(click.client.commands.some(command => command.method === 'Input.dispatchMouseEvent' && command.params?.type === 'mousePressed'), false);

  const type = fixture(), typeRespond = type.respond;
  type.setState({ ...type.state, tag: 'input', type: 'text', editable: true });
  type.setRespond(async (method, params) => {
    if (method === 'Runtime.callFunctionOn' && String(params?.functionDeclaration ?? '').includes("e.value=''")) { type.signal.abort(); return { result: { value: true } }; }
    return typeRespond(method, params);
  });
  assert.equal((await type.execute(type.request('browser_type', { text: 'must-not-arrive' }))).outcome, 'outcome_unknown');
  assert.equal(type.client.commands.some(command => command.method === 'Input.insertText'), false);
});

test('uncertain native mutation rejection is fixed-code outcome_unknown and is never replayed', async () => {
  const f = fixture(), original = f.respond;
  f.setRespond((method, params) => method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed' ? Promise.reject(new Error('secret native detail')) : original(method, params));
  const result = await f.execute(f.request('browser_click'));
  assert.equal(result.outcome, 'outcome_unknown'); assert.equal(result.code, 'browser_outcome_unknown'); assert.doesNotMatch(JSON.stringify(result), /secret native detail/);
  assert.equal(f.client.commands.filter(command => command.method === 'Input.dispatchMouseEvent' && command.params?.type === 'mousePressed').length, 1);
});

test('external detach after mutation quarantines the exact native lane until destruction', async () => {
  const f = fixture(), pending = deferred(), original = f.respond;
  f.setRespond((method, params) => method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed' ? pending.promise : original(method, params));
  const ticket = f.api.execute(f.request('browser_click'), f.context); await turn();
  f.client.emit('detach', {}, 'external'); f.client.attached = true; pending.reject(new Error('transport lost'));
  assert.equal((await ticket.result).outcome, 'outcome_unknown'); await turn(); assert.equal(f.api.isBusy(f.contents), true);
  f.setDestroyed(true); assert.equal(f.api.confirmDestroyed(f.contents), true); await ticket.settled; assert.equal(f.api.isBusy(f.contents), false);
});

test('file and readonly inputs never run the fixed clear helper or insert page text', async () => {
  for (const state of [{ tag: 'input', type: 'file', editable: false, readOnly: false }, { tag: 'input', type: 'text', editable: true, readOnly: true }]) {
    const f = fixture(); f.setState({ ...f.state, ...state }); const result = await f.execute(f.request('browser_type', { text: 'blocked' }));
    assert.equal(result.outcome, 'failed'); assert.equal(f.dispatches, 0);
    assert.equal(f.client.commands.some(command => command.method === 'Input.insertText'), false);
  }
});
