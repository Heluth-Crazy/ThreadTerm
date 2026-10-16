import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require(process.env.THREADTERM_TEST_TYPESCRIPT || 'typescript');
function modules() {
  const cache = new Map();
  function load(path) {
    path = resolve(path);
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} }; cache.set(path, module);
    const source = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    function localRequire(name) {
      if (name.startsWith('.')) {
        const next = resolve(dirname(path), name.replace(/\.js$/, '.ts'));
        if (existsSync(next)) return load(next);
      }
      return require(name);
    }
    vm.runInNewContext(`(function(require,module,exports){${source}\n})`, { Buffer, URL, Object, Map, Set, WeakSet, Promise, Date, Error, Number, String, JSON, Math, AbortController, setTimeout, clearTimeout }, { filename: path })(localRequire, module, module.exports);
    return module.exports;
  }
  return { ...load('desktop/src/browser/agentTypes.ts'), ...load('desktop/src/browser/agentGrants.ts'), ...load('desktop/src/browser/agentSnapshot.ts'), ...load('desktop/src/browser/agentTools.ts') };
}

function fixture() {
  const api = modules(), grants = new api.BrowserAgentGrants(), refs = new api.BrowserAgentSnapshotRefs();
  const registration = { tabId: 'opaque-tab', sourceTabId: 'native-tab', attachmentId: 'attachment', attachmentGeneration: 1, runtimeEpoch: 'runtime', viewGeneration: 1 };
  let document = { sourceTabId: 'native-tab', viewGeneration: 1, documentGeneration: 1, navigationEpoch: 1, url: 'https://page.test/path', available: true, loaded: true, appOrigin: 'https://threadterm.test' };
  grants.register(registration);
  const expected = () => ({ ...document, grantEpoch: grants.state('native-tab').grantEpoch });
  const share = () => grants.setShare('native-tab', 'read', expected(), document);
  class Debugger extends EventEmitter {
    attached = false; attaches = 0; detaches = 0; commands = [];
    isAttached() { return this.attached; }
    attach() { if (this.attached) throw new Error('Conflict'); this.attached = true; this.attaches++; }
    detach() { this.attached = false; this.detaches++; this.emit('detach', {}, 'own cleanup'); }
    async sendCommand(method, params) { this.commands.push({ method, params }); return respond(method, params, this); }
  }
  const debuggerClient = new Debugger();
  const frameTree = (loaderId = 'loader-main') => ({ frameTree: { frame: { id: 'main', url: document.url, securityOrigin: 'https://page.test', loaderId }, childFrames: [
    { frame: { id: 'same', parentId: 'main', url: 'https://page.test/frame', securityOrigin: 'https://page.test', loaderId: 'loader-same' } },
    { frame: { id: 'foreign', parentId: 'main', url: 'https://foreign.test/', securityOrigin: 'https://foreign.test', loaderId: 'loader-foreign' } },
  ] } });
  const nodes = [
    { nodeId: 'root', backendDOMNodeId: 1, frameId: 'main', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['button', 'password', 'iframe'] },
    { nodeId: 'button', backendDOMNodeId: 2, role: { value: 'button' }, name: { value: 'Continue' } },
    { nodeId: 'password', backendDOMNodeId: 3, role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'never-return-password' }, childIds: ['editable-text'] },
    { nodeId: 'editable-text', backendDOMNodeId: 10, role: { value: 'StaticText' }, name: { value: 'never-return-editable-child' } },
    { nodeId: 'iframe', backendDOMNodeId: 4, role: { value: 'Iframe' }, name: { value: 'Embedded' }, childIds: ['foreign-secret'] },
    { nodeId: 'foreign-secret', backendDOMNodeId: 5, frameId: 'foreign', role: { value: 'StaticText' }, name: { value: 'never-return-foreign-frame' } },
  ];
  let respond = async method => method === 'Page.getFrameTree' ? frameTree() : method === 'Accessibility.getFullAXTree' ? { nodes } : {};
  const image = (width = 2400, height = 1200, pngBytes = 100, jpegBytes = 50) => ({ isEmpty: () => false, getSize: () => ({ width, height }), resize: size => image(size.width, size.height, pngBytes, jpegBytes), toPNG: () => Buffer.alloc(pngBytes), toJPEG: quality => Buffer.alloc(quality <= 65 ? Math.min(jpegBytes, 1024) : jpegBytes) });
  let capture = async () => image();
  let canCaptureScreenshot = true;
  let contents = { debugger: debuggerClient, isDestroyed: () => false, capturePage: (...args) => capture(...args) };
  const controller = new AbortController();
  let authorize = () => undefined;
  const context = () => ({ fence: grants.captureRead('native-tab', document), signal: controller.signal, deadline: Date.now() + 10_000, getTab: () => ({ document, contents, canCaptureScreenshot }), assertAuthorized: () => authorize() });
  const call = (tool, level, override) => api.readBrowserAgentTool(grants, refs, override || context(), tool, level);
  return { api, grants, refs, registration, nodes, debuggerClient, frameTree, image, share, expected, context, call, controller, get document() { return document; }, set document(value) { document = value; }, setCapture(value) { capture = value; }, setCaptureAvailable(value) { canCaptureScreenshot = value; }, setRespond(value) { respond = value; }, setAuthorize(value) { authorize = value; }, replaceContents() { contents = { ...contents }; } };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const isCode = code => error => error?.code === code;

test('grants default Off and require a loaded supported current document', () => {
  const f = fixture();
  assert.equal(f.grants.state('native-tab').level, 'off');
  assert.throws(() => f.context(), isCode('browser_grant_required'));
  for (const url of ['about:blank', 'data:text/html,hello', 'file:///tmp/a', 'https://user:password@page.test/', 'https://threadterm.test/']) {
    f.document = { ...f.document, url }; assert.throws(() => f.share(), isCode('browser_unavailable'));
  }
  f.document = { ...f.document, url: 'https://page.test/', loaded: false }; assert.throws(() => f.share(), isCode('browser_unavailable'));
  f.document = { ...f.document, loaded: true }; f.share(); assert.equal(f.grants.state('native-tab').level, 'read');
  assert.throws(() => f.grants.setShare('native-tab', 'read', { ...f.expected(), navigationEpoch: 0 }, f.document), isCode('browser_stale_ref'));
});

test('same-origin and same-document navigation retain Read while invalidating prior reads', () => {
  const f = fixture(); f.share(); const first = f.context().fence;
  f.grants.navigationStarted('native-tab', 'https://page.test/next');
  assert.equal(f.grants.state('native-tab').level, 'read'); assert.throws(() => f.grants.assertRead(first, f.document), isCode('browser_grant_required'));
  f.document = { ...f.document, navigationEpoch: 2, documentGeneration: 2, url: 'https://page.test/next' };
  const second = f.context().fence; f.grants.navigationStarted('native-tab', 'https://page.test/next#part');
  assert.throws(() => f.grants.assertRead(second, f.document)); assert.equal(f.grants.state('native-tab').level, 'read');
});

test('cross-origin attempts revoke immediately and returning never restores authority', () => {
  const f = fixture(); f.share(); const first = f.context().fence;
  f.grants.navigationStarted('native-tab', 'https://other.test/');
  assert.equal(f.grants.state('native-tab').level, 'off'); assert.match(f.grants.state('native-tab').reason, /moved to another site/);
  f.grants.navigationStarted('native-tab', 'https://page.test/path'); assert.throws(() => f.grants.assertRead(first, f.document), isCode('browser_grant_required')); assert.throws(() => f.context(), isCode('browser_grant_required'));
});

test('Off always revokes even when its user command carries an older page fence', () => {
  const f = fixture(); const stale = f.expected(); f.share();
  f.document = { ...f.document, documentGeneration: 2, navigationEpoch: 2 };
  f.grants.setShare('native-tab', 'off', stale, f.document); assert.equal(f.grants.state('native-tab').level, 'off');
});

test('runtime registration, view replacement, lifecycle invalidation and clear fence old grants', () => {
  const f = fixture(); f.share(); const first = f.context().fence;
  const copy = f.grants.state('native-tab'); assert.ok(Object.isFrozen(copy)); assert.ok(Object.isFrozen(copy.registration));
  f.grants.register({ ...f.registration, runtimeEpoch: 'replacement' }); assert.equal(f.grants.state('native-tab').level, 'off'); assert.throws(() => f.grants.assertRead(first, f.document));
  f.share(); f.document = { ...f.document, viewGeneration: 2 }; assert.throws(() => f.context(), isCode('browser_unavailable'));
  f.document = { ...f.document, viewGeneration: 1 }; f.grants.invalidate('native-tab', 'Unloaded'); assert.throws(() => f.context(), isCode('browser_grant_required'));
  f.grants.clear(); assert.throws(() => f.context(), isCode('browser_tab_not_found'));
});

test('snapshot refs are stable for unchanged backend identities and never expose values or foreign children', () => {
  const f = fixture(); f.share(); const fence = f.context().fence;
  const one = f.api.buildBrowserAgentSnapshot(fence, 'main', f.nodes, f.refs), two = f.api.buildBrowserAgentSnapshot(fence, 'main', f.nodes, f.refs);
  assert.match(one.outline, /Password/); assert.doesNotMatch(one.outline, /never-return/); assert.match(one.outline, /embedded frame contents omitted/); assert.equal(one.omittedFrames, 1);
  const ref = one.outline.match(/button.*\[(ref-[^\]]+)\]/)[1]; assert.ok(two.outline.includes(ref)); assert.equal(f.refs.resolve(fence, ref).backendNodeId, 2);
  const changed = f.nodes.map(node => node.nodeId === 'button' ? { ...node, nodeId: 'replacement' } : node.nodeId === 'root' ? { ...node, childIds: ['replacement'] } : node);
  f.api.buildBrowserAgentSnapshot(fence, 'main', changed, f.refs); assert.throws(() => f.refs.resolve(fence, ref), isCode('browser_stale_ref'));
});

test('snapshot is UTF-8 and JSON bounded even for huge escaped text, cycles and node counts', () => {
  const f = fixture(); f.share(); const fence = f.context().fence;
  const nodes = [{ ...f.nodes[0], childIds: Array.from({ length: 5000 }, (_, index) => String(index)) }, ...Array.from({ length: 5000 }, (_, index) => ({ nodeId: String(index), backendDOMNodeId: index + 2, role: { value: 'StaticText' }, name: { value: '\\"💾'.repeat(3000) }, childIds: ['root'] }))];
  const result = f.api.buildBrowserAgentSnapshot(fence, 'main', nodes, f.refs);
  assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 60 * 1024); assert.doesNotMatch(result.outline, /\uFFFD/); assert.ok(f.refs.size <= 4096);
});

test('snapshot bounds malformed ignored graph work and marks clipped individual fields', () => {
  const f = fixture(); f.share(); const fence = f.context().fence;
  const nodes = [{ ...f.nodes[0], childIds: ['long'] }, { nodeId: 'long', name: { value: '💾'.repeat(2000) }, role: { value: 'StaticText' }, backendDOMNodeId: 2 }];
  const clipped = f.api.buildBrowserAgentSnapshot(fence, 'main', nodes, f.refs); assert.equal(clipped.truncated, true); assert.match(clipped.outline, /output truncated/);
  const dag = [{ ...f.nodes[0], childIds: ['1'] }, ...Array.from({ length: 80 }, (_, index) => ({ nodeId: String(index + 1), ignored: true, childIds: Array.from({ length: 4096 }, (_, child) => String(1 + child % 80)) }))];
  const bounded = f.api.buildBrowserAgentSnapshot(fence, 'main', dag, f.refs); assert.equal(bounded.truncated, true); assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 60 * 1024);
});

test('ref map caps capacity and fences tab, grant and document generations', () => {
  const f = fixture(); f.share(); const fence = f.context().fence;
  const first = f.refs.bind(fence, 'main', { nodeId: 'zero', backendDOMNodeId: 1 }, 'button');
  for (let index = 2; index < 4200; index++) f.refs.bind(fence, 'main', { nodeId: String(index), backendDOMNodeId: index }, 'button');
  assert.equal(f.refs.size, 4096); assert.throws(() => f.refs.resolve(fence, first.ref), isCode('browser_stale_ref'));
  const recent = f.refs.bind(fence, 'main', { nodeId: 'new', backendDOMNodeId: 9999 }, 'button');
  assert.throws(() => f.refs.resolve({ ...fence, registration: { ...fence.registration, tabId: 'other' } }, recent.ref), isCode('browser_stale_ref'));
  assert.throws(() => f.refs.resolve({ ...fence, documentGeneration: 2 }, recent.ref), isCode('browser_stale_ref'));
});

test('CDP snapshot reads only native frame/AX primitives and cleans owned attachment', async () => {
  const f = fixture(); f.share(); const result = await f.call('browser_snapshot');
  assert.match(result.outline, /Continue/); assert.equal(f.debuggerClient.attaches, 1); assert.equal(f.debuggerClient.detaches, 1); assert.equal(f.debuggerClient.listenerCount('detach'), 0);
  assert.deepEqual(f.debuggerClient.commands.map(row => row.method), ['Page.getFrameTree', 'Accessibility.getFullAXTree', 'Page.getFrameTree']);
});

test('debugger conflict and external detach never detach an unowned debugger', async () => {
  const f = fixture(); f.share(); f.debuggerClient.attached = true;
  await assert.rejects(f.call('browser_snapshot'), isCode('browser_unavailable')); assert.equal(f.debuggerClient.detaches, 0);
  f.debuggerClient.attached = false; f.setRespond(async () => { f.debuggerClient.emit('detach', {}, 'external'); f.debuggerClient.attached = true; return f.frameTree(); });
  await assert.rejects(f.call('browser_snapshot'), isCode('browser_unavailable')); assert.equal(f.debuggerClient.detaches, 0); assert.equal(f.debuggerClient.listenerCount('detach'), 0);
});

test('cancellation interrupts hanging CDP command and drains owned listeners', async () => {
  const f = fixture(); f.share(); f.setRespond(() => new Promise(() => undefined));
  const pending = f.call('browser_snapshot'); await nextTurn(); f.controller.abort();
  await assert.rejects(pending, isCode('browser_cancelled')); assert.equal(f.debuggerClient.detaches, 1); assert.equal(f.debuggerClient.listenerCount('detach'), 0); assert.equal(f.debuggerClient.listenerCount('message'), 0);
});

test('deadline bounds hanging CDP command and does not leak attachment', async () => {
  const f = fixture(); f.share(); f.setRespond(() => new Promise(() => undefined));
  await assert.rejects(f.call('browser_snapshot', undefined, { ...f.context(), deadline: Date.now() + 15 }), isCode('browser_deadline'));
  assert.equal(f.debuggerClient.detaches, 1); assert.equal(f.debuggerClient.listenerCount('detach'), 0);
});

test('external debugger detach interrupts a command that never settles', async () => {
  const f = fixture(); f.share(); f.setRespond(() => new Promise(() => undefined));
  const pending = f.call('browser_snapshot'); await nextTurn(); f.debuggerClient.emit('detach', {}, 'external');
  await assert.rejects(pending, isCode('browser_unavailable')); assert.equal(f.debuggerClient.detaches, 0); assert.equal(f.debuggerClient.listenerCount('detach'), 0);
});

test('Off and view replacement suppress completed screenshots after asynchronous capture', async () => {
  for (const mode of ['off', 'replace', 'worker']) {
    const f = fixture(); f.share(); let finish;
    f.setCapture(() => new Promise(resolve => { finish = resolve; })); const pending = f.call('browser_screenshot'); await nextTurn();
    if (mode === 'off') f.grants.setShare('native-tab', 'off', f.expected(), f.document);
    if (mode === 'replace') f.replaceContents();
    if (mode === 'worker') f.setAuthorize(() => { throw new f.api.BrowserAgentError('browser_cancelled', 'Worker replaced'); });
    finish(f.image()); await assert.rejects(pending);
  }
});

test('screenshot stays hidden, uses no disk and bounds dimensions, encoding and result', async () => {
  const f = fixture(); f.share(); let options;
  f.setCapture(async (_rect, value) => { options = value; return f.image(4000, 2000, 700 * 1024, 400 * 1024); });
  const result = await f.call('browser_screenshot'); assert.equal(options.stayHidden, true); assert.equal(options.stayAwake, true); assert.equal(result.width, 1600); assert.equal(result.height, 800); assert.equal(result.mimeType, 'image/jpeg');
  assert.ok(Buffer.from(result.data, 'base64').length <= 512 * 1024); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 900 * 1024);
  assert.match(result.provenance.thumbnail, /^data:image\/jpeg;base64,/); assert.ok(Buffer.from(result.provenance.thumbnail.split(',')[1], 'base64').length <= 16 * 1024); assert.notEqual(result.provenance.thumbnail.split(',')[1], result.data);
  assert.throws(() => f.api.encodeBrowserAgentScreenshot(f.image(4000, 2000, 700 * 1024, 600 * 1024), f.context()), isCode('browser_read_failed'));
});

test('hidden or minimized host windows reject screenshots before native capture while AX remains available', async () => {
  const f = fixture(); f.share(); let captures = 0; f.setCapture(async () => { captures++; return f.image(); }); f.setCaptureAvailable(false);
  await assert.rejects(f.call('browser_screenshot'), isCode('browser_unavailable')); assert.equal(captures, 0); assert.ok((await f.call('browser_snapshot')).outline);
});

test('an uncancellable native capture stays latched after timeout and blocks accumulation until actual settlement', async () => {
  const f = fixture(); f.share(); let captures = 0, settle; f.setCapture(() => { captures++; return new Promise(resolve => { settle = resolve; }); });
  await assert.rejects(f.call('browser_screenshot', undefined, { ...f.context(), deadline: Date.now() + 15 }), isCode('browser_deadline'));
  for (let count = 0; count < 4; count++) await assert.rejects(f.call('browser_screenshot'), isCode('browser_unavailable')); assert.equal(captures, 1);
  settle(f.image()); await nextTurn(); f.setCapture(async () => { captures++; return f.image(); }); await f.call('browser_screenshot'); assert.equal(captures, 2);
});

test('console CDP replay includes only verified current same-origin default contexts', async () => {
  const f = fixture(); f.share();
  f.setRespond(async (method, _params, client) => {
    if (method === 'Page.getFrameTree') return f.frameTree();
    if (method === 'Runtime.enable') {
      const emit = (name, params) => client.emit('message', {}, name, params);
      for (const [id, frameId, origin, isDefault] of [[1, 'main', 'https://page.test', true], [2, 'same', 'https://page.test', true], [3, 'foreign', 'https://foreign.test', true], [4, 'main', 'https://page.test', false], [5, 'main', 'https://spoof.test', true]]) emit('Runtime.executionContextCreated', { context: { id, origin, auxData: { frameId, isDefault } } });
      for (const id of [1, 2, 3, 4, 5, 99]) emit('Runtime.consoleAPICalled', { executionContextId: id, type: 'error', args: [{ type: 'string', value: `context-${id}` }, { type: 'object', description: 'never-return-object-properties' }], stackTrace: { callFrames: [{ url: 'https://page.test/spoof.js', lineNumber: 2 }] } });
      emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'unknown-context-exception' } });
    }
    return {};
  });
  const result = await f.call('browser_console_messages'); assert.equal(result.entries.length, 2); assert.equal(result.omitted, 5); assert.equal(result.entries[0].line, 3);
  assert.match(result.entries[0].text, /context-1 \[object omitted\]/); assert.doesNotMatch(JSON.stringify(result), /context-3|context-4|context-5|context-99|never-return-object|unknown-context-exception/);
  assert.equal(f.debuggerClient.listenerCount('message'), 0); assert.equal(f.debuggerClient.detaches, 1);
});

test('console drops reused and navigated contexts and bounds Unicode result bytes', async () => {
  const f = fixture(); f.share(); let treeCalls = 0;
  f.setRespond(async (method, _params, client) => {
    if (method === 'Page.getFrameTree') return f.frameTree(++treeCalls === 1 ? 'first' : 'second');
    if (method === 'Runtime.enable') {
      client.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 1, origin: 'https://page.test', auxData: { frameId: 'main', isDefault: true } } });
      for (let index = 0; index < 300; index++) client.emit('message', {}, 'Runtime.consoleAPICalled', { executionContextId: 1, type: 'warning', args: [{ type: 'string', value: '\\"💾'.repeat(10000) }] });
    }
    return {};
  });
  const result = await f.call('browser_console_messages', 'warning'); assert.equal(result.entries.length, 0); assert.equal(result.truncated, true); assert.equal(result.omitted, 300); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 60 * 1024);
});

test('console filters preserve each public debug/log/info/warning/error level', async () => {
  for (const level of ['debug', 'log', 'info', 'warning', 'error']) {
    const f = fixture(); f.share();
    f.setRespond(async (method, _params, client) => {
      if (method === 'Page.getFrameTree') return f.frameTree();
      if (method === 'Runtime.enable') {
        client.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 1, origin: 'https://page.test', auxData: { frameId: 'main', isDefault: true } } });
        for (const type of ['debug', 'log', 'info', 'warning', 'error']) client.emit('message', {}, 'Runtime.consoleAPICalled', { executionContextId: 1, type, args: [{ type: 'string', value: `${type} message` }] });
      }
      return {};
    });
    const result = await f.call('browser_console_messages', level); assert.equal(result.entries.length, 1); assert.equal(result.entries[0].level, level); assert.equal(result.entries[0].text, `${level} message`);
  }
  const f = fixture(); f.share(); await assert.rejects(f.call('browser_console_messages', 'verbose'), isCode('browser_invalid_arguments'));
});

test('console context ID reuse cannot relabel a foreign or destroyed context', async () => {
  const f = fixture(); f.share();
  f.setRespond(async (method, _params, client) => {
    if (method === 'Page.getFrameTree') return f.frameTree();
    if (method === 'Runtime.enable') {
      const emit = (name, params) => client.emit('message', {}, name, params);
      emit('Runtime.executionContextCreated', { context: { id: 1, origin: 'https://foreign.test', auxData: { frameId: 'foreign', isDefault: true } } });
      emit('Runtime.consoleAPICalled', { executionContextId: 1, type: 'error', args: [{ type: 'string', value: 'never-return-retired-foreign-context' }] });
      emit('Runtime.executionContextDestroyed', { executionContextId: 1 });
      emit('Runtime.executionContextCreated', { context: { id: 1, origin: 'https://page.test', auxData: { frameId: 'main', isDefault: true } } });
      emit('Runtime.consoleAPICalled', { executionContextId: 1, type: 'error', args: [{ type: 'string', value: 'current-context' }] });
    }
    return {};
  });
  const result = await f.call('browser_console_messages'); assert.equal(result.entries.length, 1); assert.equal(result.entries[0].text, 'current-context'); assert.equal(result.omitted, 1); assert.doesNotMatch(JSON.stringify(result), /never-return-retired/);
});

test('same-origin grandchildren inside a foreign frame remain omitted', async () => {
  const f = fixture(); f.share();
  f.setRespond(async (method, _params, client) => {
    if (method === 'Page.getFrameTree') {
      const tree = f.frameTree(); tree.frameTree.childFrames[1].childFrames = [{ frame: { id: 'nested', parentId: 'foreign', url: 'https://page.test/nested', securityOrigin: 'https://page.test', loaderId: 'nested-loader' } }]; return tree;
    }
    if (method === 'Runtime.enable') {
      client.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 1, origin: 'https://page.test', auxData: { frameId: 'nested', isDefault: true } } });
      client.emit('message', {}, 'Runtime.consoleAPICalled', { executionContextId: 1, type: 'log', args: [{ type: 'string', value: 'never-return-nested-context' }] });
    }
    return {};
  });
  const result = await f.call('browser_console_messages'); assert.equal(result.entries.length, 0); assert.equal(result.omitted, 1);
});

test('console marks clipped fields and bounds a large verified replay result', async () => {
  const f = fixture(); f.share();
  f.setRespond(async (method, _params, client) => {
    if (method === 'Page.getFrameTree') return f.frameTree();
    if (method === 'Runtime.enable') {
      client.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 1, origin: 'https://page.test', auxData: { frameId: 'main', isDefault: true } } });
      for (let index = 0; index < 80; index++) client.emit('message', {}, 'Runtime.consoleAPICalled', { executionContextId: 1, type: 'error', args: [{ type: 'string', value: '\\"💾'.repeat(10000) }] });
    }
    return {};
  });
  const result = await f.call('browser_console_messages'); assert.ok(result.entries.length > 0); assert.equal(result.truncated, true); assert.ok(result.omitted > 0); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 60 * 1024);
});
