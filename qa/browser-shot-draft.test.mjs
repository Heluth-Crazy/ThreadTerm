import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url), ts = require('typescript');
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const shot = (id = ids[0]) => ({ id, path:`D:/shots/${id}.png`, thumbnail:'data:image/png;base64,c2hvdA==' });
const packet = (id = ids[0]) => ({ shot:shot(id), url:'http://localhost:5173/page', dataUrl:`data:image/png;base64,${id}` });
const plain = value => JSON.parse(JSON.stringify(value));

function runner() {
  const hooks = []; let index = 0, current, dirty = false;
  const equal = (a, b) => a?.length === b?.length && a.every((value, at) => Object.is(value, b[at]));
  const react = {
    useState(initial) { const at = index++; if (!hooks[at]) hooks[at] = { value:typeof initial === 'function' ? initial() : initial }; const hook = hooks[at]; return [hook.value, value => { hook.value = typeof value === 'function' ? value(hook.value) : value; dirty = true; }]; },
    useRef(value) { const at = index++; return hooks[at] ??= { current:value }; },
    useEffect(effect, deps) { const at = index++, hook = hooks[at] ??= {}; if (!equal(hook.deps, deps)) { hook.deps = deps; hook.pending = effect; } },
  };
  const render = (fn, options) => { current = { fn, options }; do { dirty = false; index = 0; current.value = fn(options); for (const hook of hooks) if (hook?.pending) { const effect = hook.pending; hook.pending = undefined; hook.cleanup?.(); hook.cleanup = effect(); } } while (dirty); return current.value; };
  return { react, render:options => render(current.fn, options), renderAsync:async options => { render(current.fn, options); await new Promise(setImmediate); return render(current.fn, options); }, mount:(fn, options) => render(fn, options), dispose:() => hooks.forEach(hook => hook?.cleanup?.()) };
}

function load(react, storage, deleted, readShot = async id => packet(id).dataUrl) {
  const source = readFileSync('renderer/src/pageShotDraft.ts', 'utf8');
  const code = ts.transpileModule(source, { compilerOptions:{ module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.ReactJSX, esModuleInterop:true } }).outputText;
  const module = { exports:{} };
  const bridge = { browserHandoff:async()=>undefined, cancelPagePick:async()=>{}, deletePageShots:async ids => { deleted.push(...ids); }, markPageTarget:async()=>{}, pickPageTarget:async()=>undefined, readPageShot:readShot };
  const localRequire = name => {
    if (name === 'react') return react;
    if (name === './bridge') return bridge;
    throw new Error(`Unexpected screenshot draft dependency: ${name}`);
  };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})(require,module,module.exports)`, { require:localRequire, module, URL, localStorage:storage, console, Promise, setTimeout, clearTimeout });
  return module.exports;
}

function memoryStorage() { const values = new Map(); return { getItem:key => values.get(key) ?? null, setItem:(key, value) => values.set(key, value), removeItem:key => values.delete(key), values }; }
function compose(sessionId, imageMode = 'accept') {
  const state = { sessionId, images:[], contextItems:[], inserted:[], issues:[] };
  const options = () => ({ sessionId:state.sessionId, images:state.images, contextItems:state.contextItems, visible:() => true,
    attachImages:incoming => { if (imageMode === 'unsupported') return 0; state.images = [...state.images, ...incoming]; return incoming.length; },
    updateImages:next => { state.images = next; return true; }, attachContext:item => { state.contextItems = [...state.contextItems, item]; return true; }, removeContext:id => { state.contextItems = state.contextItems.filter(item => item.id !== id); }, onIssue:message => state.issues.push(message),
  });
  const host = { insert:async(id, text) => { state.inserted.push([id, text]); } };
  return { state, options, host };
}

test('hydrates image metadata and attaches a page screenshot without sending', async () => {
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted), composeState = compose('chat-a'); composeState.state.images = [packet().dataUrl];
  storage.setItem('threadterm.compose.page-shots.chat-a', JSON.stringify([{ shot:shot(), url:'http://localhost:5173/page', mode:'image', imageIndex:0 }]));
  let draft = hooks.mount(api.usePageShotDraft, composeState.options());
  assert.deepEqual(plain(draft.records.map(record => ({ mode:record.mode, imageIndex:record.imageIndex, path:record.shot.path }))), [{ mode:'image', imageIndex:0, path:shot().path }]);
  await api.addPageShotToDraft(composeState.host, 'chat-a', packet(ids[1])); draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(composeState.state.inserted, [['chat-a', '']]);
  assert.equal(composeState.state.images.at(-1), packet(ids[1]).dataUrl);
  assert.equal(composeState.state.contextItems.at(-1).id, `browser-shot:${ids[1]}`);
  assert.equal(draft.records.at(-1).mode, 'image'); assert.equal(draft.records.at(-1).imageIndex, 1);
  hooks.dispose();
});

test('parent hydration from empty native drafts preserves stored image metadata', () => {
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted), saved = packet();
  storage.setItem('threadterm.compose.page-shots.chat-parent', JSON.stringify([{ shot:saved.shot, url:saved.url, mode:'image', imageIndex:0 }]));
  function parent() {
    const [images, setImages] = hooks.react.useState([]), [contextItems, setContextItems] = hooks.react.useState([]);
    hooks.react.useEffect(() => { setImages([saved.dataUrl]); setContextItems([{ id:`browser-shot:${ids[0]}` }]); }, []);
    return api.usePageShotDraft({ sessionId:'chat-parent', images, contextItems, visible:() => true, attachImages:() => 0, updateImages:() => true, attachContext:() => true, removeContext:() => {}, onIssue:message => { throw Error(message); } });
  }
  const draft = hooks.mount(parent, undefined);
  assert.equal(draft.records.length, 1); assert.equal(draft.records[0].imageIndex, 0); assert.deepEqual(deleted, []);
  assert.ok(storage.values.has('threadterm.compose.page-shots.chat-parent'));
});

test('unsupported image remains an offer until kept, then reloads as a file reference', async () => {
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted), composeState = compose('chat-b', 'unsupported');
  let draft = hooks.mount(api.usePageShotDraft, composeState.options());
  await api.addPageShotToDraft(composeState.host, 'chat-b', packet()); draft = await hooks.renderAsync(composeState.options());
  assert.equal(draft.records[0].mode, 'offer'); assert.deepEqual(composeState.state.images, []); assert.deepEqual(composeState.state.contextItems, []);
  draft.keep(ids[0]); draft = await hooks.renderAsync(composeState.options());
  assert.equal(draft.records[0].mode, 'file'); assert.equal(composeState.state.contextItems[0].id, `browser-shot:${ids[0]}`);
  hooks.dispose();
  const reload = runner(), reloaded = load(reload.react, storage, deleted), second = compose('chat-b', 'unsupported'); second.state.contextItems = [{ id:`browser-shot:${ids[0]}` }];
  draft = reload.mount(reloaded.usePageShotDraft, second.options());
  assert.equal(draft.records[0].mode, 'file'); assert.equal(draft.records[0].shot.path, shot().path);
});

test('remove deletes backing file, image and page-data context', async () => {
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted), composeState = compose('chat-c');
  let draft = hooks.mount(api.usePageShotDraft, composeState.options()); await api.addPageShotToDraft(composeState.host, 'chat-c', packet()); draft = await hooks.renderAsync(composeState.options());
  await draft.remove(ids[0]); draft = await hooks.renderAsync(composeState.options()); await Promise.resolve();
  assert.deepEqual(plain(draft.records), []); assert.deepEqual(composeState.state.images, []); assert.deepEqual(composeState.state.contextItems, []); assert.deepEqual(deleted, [ids[0]]);
});

test('native send cleanup deletes image shots but keeps accepted file references', async () => {
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted), image = compose('chat-send-image');
  let draft = hooks.mount(api.usePageShotDraft, image.options()); await api.addPageShotToDraft(image.host, 'chat-send-image', packet()); draft = await hooks.renderAsync(image.options());
  image.state.images = []; image.state.contextItems = []; draft = await hooks.renderAsync(image.options()); await Promise.resolve();
  assert.deepEqual(plain(draft.records), []); assert.deepEqual(deleted, [ids[0]]);
  const fileHooks = runner(), fileApi = load(fileHooks.react, storage, deleted), file = compose('chat-send-file', 'unsupported');
  draft = fileHooks.mount(fileApi.usePageShotDraft, file.options()); await fileApi.addPageShotToDraft(file.host, 'chat-send-file', packet(ids[1])); draft = await fileHooks.renderAsync(file.options()); draft.keep(ids[1]); draft = await fileHooks.renderAsync(file.options());
  file.state.contextItems = []; draft = await fileHooks.renderAsync(file.options()); await Promise.resolve();
  assert.deepEqual(plain(draft.records), []); assert.deepEqual(deleted, [ids[0]], 'accepted file references retain their backing shot after send cleanup');
});

test('local draft-save failure rolls back a native image and page-data context', async () => {
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted), composeState = compose('chat-rollback');
  storage.setItem = () => { throw Error('storage full'); };
  let draft = hooks.mount(api.usePageShotDraft, composeState.options());
  await assert.rejects(api.addPageShotToDraft(composeState.host, 'chat-rollback', packet()), /storage full/);
  draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(composeState.state.images, []); assert.deepEqual(composeState.state.contextItems, []); assert.deepEqual(plain(draft.records), []); assert.deepEqual(deleted, []);
});

test('pending offers and receiver registrations stay isolated across session switching', async () => {
  const storage = memoryStorage(), deleted = [], apiA = runner(), api = load(apiA.react, storage, deleted), a = compose('chat-a', 'unsupported'), b = compose('chat-b', 'unsupported');
  let draftA = apiA.mount(api.usePageShotDraft, a.options()); await api.addPageShotToDraft(a.host, 'chat-a', packet()); draftA = await apiA.renderAsync(a.options());
  const hooksB = runner(), apiB = load(hooksB.react, storage, deleted); let draftB = hooksB.mount(apiB.usePageShotDraft, b.options());
  assert.equal(draftA.records[0].mode, 'offer'); assert.deepEqual(plain(draftB.records), []);
  await apiB.addPageShotToDraft(b.host, 'chat-b', packet(ids[1])); draftB = await hooksB.renderAsync(b.options());
  assert.equal(draftB.records[0].shot.id, ids[1]); assert.equal(draftA.records[0].shot.id, ids[0]);
});

test('reindexes later page-shot metadata after an earlier pasted image is removed', async () => {
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted), composeState = compose('chat-index');
  composeState.state.images = ['pasted-before']; let draft = hooks.mount(api.usePageShotDraft, composeState.options());
  await api.addPageShotToDraft(composeState.host, 'chat-index', packet(ids[0])); draft = await hooks.renderAsync(composeState.options());
  await api.addPageShotToDraft(composeState.host, 'chat-index', packet(ids[1])); draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(plain(draft.records.map(record => record.imageIndex)), [1, 2]);
  composeState.state.images = composeState.state.images.slice(1); draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(plain(draft.records.map(record => record.imageIndex)), [0, 1]);
});

for (const firstRemoved of [0, 1]) test(`identical screenshots retain separate badges and remove independently (${firstRemoved} first)`, async () => {
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted, async () => image), composeState = compose('chat-identical');
  const image = 'data:image/png;base64,c2FtZQ==';
  let draft = hooks.mount(api.usePageShotDraft, composeState.options());
  for (const id of ids.slice(0, 2)) {
    await api.addPageShotToDraft(composeState.host, 'chat-identical', { ...packet(id), dataUrl:image });
    draft = await hooks.renderAsync(composeState.options());
  }
  composeState.state.images = [...composeState.state.images]; draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(plain(draft.records.map(record => record.imageIndex)), [0, 1]);
  assert.deepEqual(composeState.state.contextItems.map(item => item.id), ids.slice(0, 2).map(id => `browser-shot:${id}`));
  const remaining = 1 - firstRemoved;
  await draft.remove(ids[firstRemoved]); draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(plain(draft.records.map(record => [record.shot.id, record.imageIndex])), [[ids[remaining], 0]]);
  assert.deepEqual(composeState.state.images, [image]);
  assert.deepEqual(composeState.state.contextItems.map(item => item.id), [`browser-shot:${ids[remaining]}`]);
  assert.deepEqual(deleted, [ids[firstRemoved]]);
  await draft.remove(ids[remaining]); draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(plain(draft.records), []); assert.deepEqual(composeState.state.images, []);
  assert.deepEqual(composeState.state.contextItems, []); assert.deepEqual(deleted, [ids[firstRemoved], ids[remaining]]);
  hooks.dispose();
});

test('duplicate ordinary attachments reserve their occurrence through screenshot reconciliation and reorder', async () => {
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted, async () => image), composeState = compose('chat-ordinary-duplicate');
  const image = 'data:image/png;base64,c2FtZQ==';
  composeState.state.images = [image]; let draft = hooks.mount(api.usePageShotDraft, composeState.options());
  for (const id of ids.slice(0, 2)) {
    await api.addPageShotToDraft(composeState.host, 'chat-ordinary-duplicate', { ...packet(id), dataUrl:image });
    draft = await hooks.renderAsync(composeState.options());
  }
  assert.deepEqual(plain(draft.records.map(record => record.imageIndex)), [1, 2]);
  composeState.state.images = ['ordinary-unique', ...composeState.state.images]; draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(plain(draft.records.map(record => record.imageIndex)), [2, 3]);
  composeState.state.images = [...composeState.state.images.slice(1), 'ordinary-unique']; draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(plain(draft.records.map(record => record.imageIndex)), [1, 2]);
  await draft.remove(ids[0]); draft = await hooks.renderAsync(composeState.options());
  await draft.remove(ids[1]); draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(composeState.state.images, [image, 'ordinary-unique']);
  assert.deepEqual(plain(draft.records), []); assert.deepEqual(composeState.state.contextItems, []);
  assert.deepEqual(deleted, ids.slice(0, 2)); hooks.dispose();
});

test('removing an ordinary equal-byte image preserves the tracked screenshot and backing file', async () => {
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted, async () => image), composeState = compose('chat-remove-ordinary-duplicate');
  const image = 'data:image/png;base64,c2FtZQ==';
  composeState.state.images = [image]; let draft = hooks.mount(api.usePageShotDraft, composeState.options());
  await api.addPageShotToDraft(composeState.host, composeState.state.sessionId, { ...packet(), dataUrl:image }); draft = await hooks.renderAsync(composeState.options());
  composeState.state.images = composeState.state.images.slice(1); draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(plain(draft.records.map(record => [record.shot.id, record.imageIndex])), [[ids[0], 0]]);
  assert.deepEqual(composeState.state.images, [image]); assert.deepEqual(deleted, []);
  assert.deepEqual(composeState.state.contextItems.map(item => item.id), [`browser-shot:${ids[0]}`]);
  await draft.remove(ids[0]); draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(composeState.state.images, []); assert.deepEqual(plain(draft.records), []); assert.deepEqual(deleted, [ids[0]]);
  hooks.dispose();
});

test('metadata removal failure restores native images so retry cannot delete an unrelated attachment', async () => {
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted), composeState = compose('chat-remove-rollback');
  let draft = hooks.mount(api.usePageShotDraft, composeState.options());
  for (const id of ids.slice(0, 2)) {
    await api.addPageShotToDraft(composeState.host, 'chat-remove-rollback', packet(id));
    draft = await hooks.renderAsync(composeState.options());
  }
  composeState.state.images = [...composeState.state.images, 'unrelated-image']; draft = await hooks.renderAsync(composeState.options());
  const beforeImages = [...composeState.state.images], beforeMetadata = storage.getItem('threadterm.compose.page-shots.chat-remove-rollback');
  const setItem = storage.setItem; let writes = 0;
  storage.setItem = (key, value) => { if (++writes === 2) throw Error('metadata storage full'); setItem(key, value); };
  await draft.remove(ids[0]); draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(composeState.state.images, beforeImages);
  assert.equal(storage.getItem('threadterm.compose.page-shots.chat-remove-rollback'), beforeMetadata);
  assert.deepEqual(plain(draft.records.map(record => [record.shot.id, record.imageIndex])), [[ids[0], 0], [ids[1], 1]]);
  assert.equal(composeState.state.contextItems.length, 2); assert.deepEqual(deleted, []);
  assert.match(composeState.state.issues[0], /metadata storage full/);
  await draft.remove(ids[0]); draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(composeState.state.images, [packet(ids[1]).dataUrl, 'unrelated-image']);
  assert.deepEqual(plain(draft.records.map(record => [record.shot.id, record.imageIndex])), [[ids[1], 0]]);
  await draft.remove(ids[1]); draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(composeState.state.images, ['unrelated-image']); assert.deepEqual(plain(draft.records), []);
  assert.deepEqual(composeState.state.contextItems, []); assert.deepEqual(deleted, ids.slice(0, 2)); hooks.dispose();
});

test('failed native rollback keeps durable file offers so retry and remount cannot delete an unrelated image', async () => {
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted), composeState = compose('chat-remove-rollback-rejected');
  let updates = 0;
  const options = () => ({ ...composeState.options(), updateImages:next => { if (++updates === 2) return false; composeState.state.images = next; return true; } });
  let draft = hooks.mount(api.usePageShotDraft, options());
  for (const id of ids.slice(0, 2)) {
    await api.addPageShotToDraft(composeState.host, composeState.state.sessionId, packet(id)); draft = await hooks.renderAsync(options());
  }
  composeState.state.images = [...composeState.state.images, 'unrelated-image']; draft = await hooks.renderAsync(options());
  const setItem = storage.setItem; let writes = 0;
  storage.setItem = (key, value) => { if (++writes === 2) throw Error('metadata storage full'); setItem(key, value); };
  await draft.remove(ids[0]); draft = await hooks.renderAsync(options());
  assert.equal(updates, 2, 'native removal succeeds and its rollback rejects');
  assert.deepEqual(composeState.state.images, [packet(ids[1]).dataUrl, 'unrelated-image']);
  assert.deepEqual(plain(draft.records.map(record => [record.shot.id, record.mode, record.imageIndex])), [[ids[0], 'offer', null], [ids[1], 'offer', null]]);
  assert.deepEqual(deleted, []); assert.equal(composeState.state.contextItems.length, 2);
  assert.ok(composeState.state.issues.some(message => /kept as file offers/.test(message)));
  assert.ok(composeState.state.issues.some(message => /metadata storage full/.test(message)));
  hooks.dispose();
  const reloadedHooks = runner(), reloaded = load(reloadedHooks.react, storage, deleted);
  draft = reloadedHooks.mount(reloaded.usePageShotDraft, options());
  assert.deepEqual(plain(draft.records.map(record => record.mode)), ['offer', 'offer']);
  for (const id of ids.slice(0, 2)) { await draft.remove(id); draft = await reloadedHooks.renderAsync(options()); }
  assert.equal(updates, 2, 'file-offer removal never mutates the remaining native images');
  assert.deepEqual(composeState.state.images, [packet(ids[1]).dataUrl, 'unrelated-image']);
  assert.deepEqual(deleted, ids.slice(0, 2)); assert.deepEqual(plain(draft.records), []); assert.deepEqual(composeState.state.contextItems, []);
  reloadedHooks.dispose();
});

for (const mutation of ['delete', 'reorder']) test(`failed ${mutation} reconciliation cannot remove an unrelated image on retry or remount`, async () => {
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted), composeState = compose(`chat-stale-${mutation}`);
  composeState.state.images = ['pasted-image']; let draft = hooks.mount(api.usePageShotDraft, composeState.options());
  await api.addPageShotToDraft(composeState.host, composeState.state.sessionId, packet()); draft = await hooks.renderAsync(composeState.options());
  composeState.state.images = [...composeState.state.images, 'unrelated-image']; draft = await hooks.renderAsync(composeState.options());
  const key = `threadterm.compose.page-shots.${composeState.state.sessionId}`, beforeMetadata = storage.getItem(key);
  storage.setItem = () => { throw Error('metadata storage full'); };
  composeState.state.images = mutation === 'delete' ? [packet().dataUrl, 'unrelated-image'] : ['unrelated-image', 'pasted-image', packet().dataUrl];
  const expected = [...composeState.state.images]; draft = await hooks.renderAsync(composeState.options());
  assert.equal(draft.records[0].imageIndex, 1, 'failed persistence leaves the original index stale');
  assert.ok(composeState.state.issues.some(message => /metadata storage full/.test(message)));
  await draft.remove(ids[0]); draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(composeState.state.images, expected); assert.deepEqual(deleted, []);
  assert.equal(storage.getItem(key), beforeMetadata); assert.equal(composeState.state.contextItems.length, 1);
  assert.match(composeState.state.issues.at(-1), /could not be verified/);
  hooks.dispose();
  const reloadedHooks = runner(), reloaded = load(reloadedHooks.react, storage, deleted);
  draft = reloadedHooks.mount(reloaded.usePageShotDraft, composeState.options());
  assert.equal(draft.records[0].imageIndex, 1);
  for (let retry = 0; retry < 2; retry++) { await draft.remove(ids[0]); draft = await reloadedHooks.renderAsync(composeState.options()); }
  assert.deepEqual(composeState.state.images, expected); assert.deepEqual(deleted, []);
  assert.equal(storage.getItem(key), beforeMetadata); assert.equal(composeState.state.contextItems.length, 1); assert.equal(draft.records.length, 1);
  reloadedHooks.dispose();
});

for (const unavailable of ['missing', 'error']) test(`unavailable screenshot bytes (${unavailable}) preserve image, context and backing metadata`, async () => {
  let failRead = false;
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted, async id => { if (!failRead) return packet(id).dataUrl; if (unavailable === 'error') throw Error('screenshot read failed'); return undefined; }), composeState = compose(`chat-shot-${unavailable}`);
  let draft = hooks.mount(api.usePageShotDraft, composeState.options());
  await api.addPageShotToDraft(composeState.host, composeState.state.sessionId, packet()); draft = await hooks.renderAsync(composeState.options());
  failRead = true;
  const beforeMetadata = storage.getItem(`threadterm.compose.page-shots.${composeState.state.sessionId}`);
  await draft.remove(ids[0]); draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(composeState.state.images, [packet().dataUrl]); assert.deepEqual(deleted, []);
  assert.equal(draft.records.length, 1); assert.equal(composeState.state.contextItems.length, 1);
  assert.equal(storage.getItem(`threadterm.compose.page-shots.${composeState.state.sessionId}`), beforeMetadata);
  assert.match(composeState.state.issues[0], unavailable === 'error' ? /screenshot read failed/ : /could not be verified/);
  hooks.dispose();
});

test('pending screenshot verification uses the latest reconciled index after image reorder', async () => {
  let resolveRead, deferRead = false;
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted, id => { if (!deferRead) return Promise.resolve(packet(id).dataUrl); deferRead = false; return new Promise(resolve => { resolveRead = resolve; }); }), composeState = compose('chat-shot-read-reorder');
  let draft = hooks.mount(api.usePageShotDraft, composeState.options());
  await api.addPageShotToDraft(composeState.host, composeState.state.sessionId, packet()); draft = await hooks.renderAsync(composeState.options());
  composeState.state.images = [...composeState.state.images, 'unrelated-image']; draft = await hooks.renderAsync(composeState.options());
  deferRead = true; const pending = draft.remove(ids[0]);
  composeState.state.images = ['unrelated-image', packet().dataUrl]; draft = await hooks.renderAsync(composeState.options());
  resolveRead(packet().dataUrl); await pending; draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(composeState.state.images, ['unrelated-image']); assert.deepEqual(deleted, [ids[0]]);
  assert.deepEqual(plain(draft.records), []); hooks.dispose();
});

test('session switching cancels pending screenshot removal without mutating either compose draft', async () => {
  let resolveRead, deferRead = false;
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted, id => { if (!deferRead) return Promise.resolve(packet(id).dataUrl); deferRead = false; return new Promise(resolve => { resolveRead = resolve; }); }), a = compose('chat-shot-read-a'), b = compose('chat-shot-read-b');
  let draft = hooks.mount(api.usePageShotDraft, a.options());
  await api.addPageShotToDraft(a.host, a.state.sessionId, packet()); draft = await hooks.renderAsync(a.options());
  deferRead = true; const pending = draft.remove(ids[0]); b.state.images = ['unrelated-image']; draft = await hooks.renderAsync(b.options());
  resolveRead(packet().dataUrl); await pending; draft = await hooks.renderAsync(b.options());
  assert.deepEqual(a.state.images, [packet().dataUrl]); assert.deepEqual(b.state.images, ['unrelated-image']);
  assert.deepEqual(deleted, []); assert.equal(a.state.contextItems.length, 1); assert.deepEqual(plain(draft.records), []);
  assert.ok(storage.getItem('threadterm.compose.page-shots.chat-shot-read-a')); hooks.dispose();
});

test('automatic cleanup after failed reconciliation and remount rebinds a surviving screenshot instead of deleting its backing', async () => {
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted), composeState = compose('chat-auto-stale-remount');
  composeState.state.images = ['pasted-image']; let draft = hooks.mount(api.usePageShotDraft, composeState.options());
  await api.addPageShotToDraft(composeState.host, composeState.state.sessionId, packet()); draft = await hooks.renderAsync(composeState.options());
  composeState.state.images = [...composeState.state.images, 'unrelated-image']; draft = await hooks.renderAsync(composeState.options());
  const setItem = storage.setItem; storage.setItem = () => { throw Error('metadata storage full'); };
  composeState.state.images = composeState.state.images.slice(1); draft = await hooks.renderAsync(composeState.options());
  assert.equal(draft.records[0].imageIndex, 1); assert.deepEqual(deleted, []); hooks.dispose();
  const reloadedHooks = runner(), reloaded = load(reloadedHooks.react, storage, deleted);
  draft = reloadedHooks.mount(reloaded.usePageShotDraft, composeState.options());
  assert.equal(draft.records[0].imageIndex, 1, 'persisted metadata still points at the ordinary image');
  storage.setItem = setItem;
  composeState.state.images = [packet().dataUrl]; draft = await reloadedHooks.renderAsync(composeState.options());
  assert.deepEqual(plain(draft.records.map(record => [record.shot.id, record.imageIndex])), [[ids[0], 0]]);
  assert.deepEqual(deleted, []); assert.equal(composeState.state.contextItems.length, 1);
  assert.equal(JSON.parse(storage.getItem('threadterm.compose.page-shots.chat-auto-stale-remount'))[0].imageIndex, 0);
  await draft.remove(ids[0]); draft = await reloadedHooks.renderAsync(composeState.options());
  assert.deepEqual(composeState.state.images, []); assert.deepEqual(deleted, [ids[0]]); assert.deepEqual(plain(draft.records), []);
  reloadedHooks.dispose();
});

for (const unavailable of ['missing', 'error']) test(`automatic reconciliation preserves unreadable (${unavailable}) screenshots as durable offers`, async () => {
  let failRead = false;
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted, async id => { if (!failRead) return packet(id).dataUrl; if (unavailable === 'error') throw Error('read failed'); return undefined; }), composeState = compose(`chat-auto-${unavailable}`);
  let draft = hooks.mount(api.usePageShotDraft, composeState.options());
  await api.addPageShotToDraft(composeState.host, composeState.state.sessionId, packet()); draft = await hooks.renderAsync(composeState.options());
  failRead = true; composeState.state.images = ['unrelated-image']; draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(plain(draft.records.map(record => [record.shot.id, record.mode, record.imageIndex])), [[ids[0], 'offer', null]]);
  assert.deepEqual(deleted, []); assert.equal(composeState.state.contextItems.length, 1); assert.deepEqual(composeState.state.images, ['unrelated-image']);
  assert.match(composeState.state.contextItems[0].text, /Review the draft image attachments/);
  assert.doesNotMatch(composeState.state.contextItems[0].text, /attached as an image/);
  assert.match(composeState.state.issues.at(-1), /kept as file offers/); hooks.dispose();
  const reloadedHooks = runner(), reloaded = load(reloadedHooks.react, storage, deleted);
  draft = reloadedHooks.mount(reloaded.usePageShotDraft, composeState.options());
  assert.equal(draft.records[0].mode, 'offer'); assert.deepEqual(deleted, []); reloadedHooks.dispose();
});

for (const change of ['newer-images', 'newer-records', 'switch-session', 'unmount']) test(`automatic cleanup discards verification after ${change}`, async () => {
  let resolveRead, deferRead = false;
  const storage = memoryStorage(), deleted = [], hooks = runner(), api = load(hooks.react, storage, deleted, id => { if (!deferRead) return Promise.resolve(packet(id).dataUrl); deferRead = false; return new Promise(resolve => { resolveRead = resolve; }); }), composeState = compose(`chat-auto-fence-${change}`);
  let draft = hooks.mount(api.usePageShotDraft, composeState.options());
  await api.addPageShotToDraft(composeState.host, composeState.state.sessionId, packet()); draft = await hooks.renderAsync(composeState.options());
  deferRead = true; composeState.state.images = []; draft = hooks.render(composeState.options());
  if (change === 'newer-images') { composeState.state.images = [packet().dataUrl]; draft = await hooks.renderAsync(composeState.options()); }
  else if (change === 'newer-records') { draft.keep(ids[0]); draft = await hooks.renderAsync(composeState.options()); }
  else if (change === 'switch-session') { composeState.state.sessionId = 'chat-other'; draft = await hooks.renderAsync(composeState.options()); }
  else hooks.dispose();
  resolveRead(packet().dataUrl); await new Promise(setImmediate);
  if (change !== 'unmount') draft = await hooks.renderAsync(composeState.options());
  assert.deepEqual(deleted, []); assert.ok(composeState.state.contextItems.some(item => item.id === `browser-shot:${ids[0]}`));
  if (change === 'newer-images') assert.equal(draft.records[0].imageIndex, 0);
  if (change === 'newer-records') assert.equal(draft.records[0].mode, 'file');
  if (change !== 'unmount') hooks.dispose();
});
