import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';

const require = createRequire(resolve('package.json'));
type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const root = mkdtempSync(join(resolve('desktop-dist'), 'page-comments-test-'));
let profile = root;
const shots = join(root, 'page-comments');
mkdirSync(shots);
const oldId = randomUUID();
const freshId = randomUUID();
writeFileSync(join(shots, `${oldId}.png`), 'old');
writeFileSync(join(shots, `${freshId}.jpg`), 'fresh');
const oldDate = new Date(Date.now() - 31 * 86400000);
utimesSync(join(shots, `${oldId}.png`), oldDate, oldDate);
writeFileSync(join(shots, 'unowned.txt'), 'preserve');

const electronPath = require.resolve('electron');
const cached = require.cache[electronPath];
let webContentsCreated: ((event: unknown, contents: EventEmitter) => void) | undefined;
require.cache[electronPath] = { exports: {
  app: { getPath: () => profile, on: (name: string, listener: (event: unknown, contents: EventEmitter) => void) => { if (name === 'web-contents-created') webContentsCreated = listener; } },
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  BrowserWindow: { fromWebContents: () => ({ getContentSize: () => [1200, 900] }) },
} } as NodeModule;
const registered = import('../src/pageComments.js').then(({ registerPageComments }) => {
  registerPageComments((event: IpcMainInvokeEvent) => { if (!(event as unknown as { trusted: boolean }).trusted) throw new Error('Untrusted renderer'); });
});
test.after(async () => {
  if (cached) require.cache[electronPath] = cached;
  else delete require.cache[electronPath];
  await rm(root, { recursive: true, force: true });
});

async function invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
  await registered;
  return handlers.get(`threadterm:${channel}`)!(event, ...args);
}

function fixture() {
  const executions: Array<{ source: string; done: (value: unknown) => void }> = [];
  const parent = { framesInSubtree: [] as unknown[] };
  const frame = { parent, detached: false, name: 'tt-preview-abcdefgh', processId: 2, routingId: 3,
    executeJavaScript: (source: string) => new Promise<unknown>(done => {
      executions.push({ source, done });
      if (source.endsWith('("cancel",undefined,undefined)')) done(true);
      if (source.includes(')("mark",')) done(true);
    }),
  };
  const captureRects: unknown[] = [];
  const jpegQualities: number[] = [];
  const image = (width = 3200, height = 1800) => ({
    isEmpty: () => false, getSize: () => ({ width, height }),
    resize: (size: { width: number; height: number }) => image(size.width, size.height),
    toPNG: () => Buffer.from('png'),
    toJPEG: (q: number) => { jpegQualities.push(q); return Buffer.from('jpeg'); },
  });
  const sender = Object.assign(new EventEmitter(), { id: Math.random(), isDestroyed: () => false,
    mainFrame: Object.assign(parent, { framesInSubtree: [frame] }), getZoomFactor: () => 1.25,
    capturePage: async (rect: unknown) => { captureRects.push(rect); return image(); },
  });
  return { frame, sender, executions, captureRects, jpegQualities, event: { sender, trusted: true } };
}

function pick() {
  return { url: 'https://example.com/', title: 'Test', viewport: { width: 800, height: 600 }, target: {
    type: 'element', selector: '#save', tag: 'button', label: 'button "Save"', attributes: {}, html: '<button>Save', rect: { x: 40, y: 100, width: 136, height: 43 },
  } };
}
const frameRect = { x: 100, y: 50, width: 800, height: 600 };

test('every page-comment IPC authenticates the calling renderer', async () => {
  for (const channel of ['pick-page-target', 'cancel-page-pick', 'mark-page-target', 'read-page-shot', 'delete-page-shots', 'select-all-page-text']) {
    await assert.rejects(invoke(channel, { trusted: false }), /Untrusted renderer/);
  }
});

test('frame lookup stays in calling webContents and requires a named child', async () => {
  const { event, frame, executions } = fixture();
  assert.equal(await invoke('pick-page-target', event, { frameName: 'tt-preview-otherone', frameRect }), null);
  assert.equal(executions.length, 0);
  Object.assign(frame, { parent: null });
  assert.equal(await invoke('pick-page-target', event, { frameName: frame.name, frameRect }), null);
  await assert.rejects(invoke('cancel-page-pick', event, 'tt-probe'), /Invalid preview frame/);
});

test('new pick, navigation, explicit cancellation and detached frames resolve null', async () => {
  const { event, sender, frame, executions } = fixture();
  const first = invoke('pick-page-target', event, { frameName: frame.name, frameRect });
  const second = invoke('pick-page-target', event, { frameName: frame.name, frameRect });
  assert.equal(await first, null);
  await new Promise<void>(done => setImmediate(done));
  sender.emit('did-frame-navigate', {}, 'https://example.com/new', 200, 'OK', false, 2, 3);
  assert.equal(await second, null);
  const third = invoke('pick-page-target', event, { frameName: frame.name, frameRect });
  await invoke('cancel-page-pick', event, frame.name);
  assert.equal(await third, null);
  assert.ok(executions.some(({ source }) => source.endsWith('("cancel",undefined,undefined)')));
  const fourth = invoke('pick-page-target', event, { frameName: frame.name, frameRect });
  await new Promise<void>(done => setImmediate(done));
  frame.detached = true;
  // Keep node alive while the unref'ed detached-frame monitor runs.
  const keepAlive = setTimeout(() => {}, 300);
  try { assert.equal(await fourth, null); } finally { clearTimeout(keepAlive); }
  assert.equal(sender.listenerCount('did-frame-navigate'), 0);
  assert.equal(sender.listenerCount('destroyed'), 0);
  assert.equal(sender.listenerCount('did-start-navigation'), 0);
});

test('navigation during an unfinished capture resolves null and deletes the late shot', async () => {
  const { event, frame, sender, executions } = fixture();
  const before = (await readdir(shots)).sort();
  let finishCapture!: (image: unknown) => void;
  const originalCapture = sender.capturePage;
  Object.assign(sender, { capturePage: () => new Promise(done => { finishCapture = done; }) });
  const pending = invoke('pick-page-target', event, { frameName: frame.name, frameRect });
  await new Promise<void>(done => setImmediate(done)); executions[0].done(pick());
  await new Promise<void>(done => setImmediate(done));
  assert.equal(typeof finishCapture, 'function');
  sender.emit('did-start-navigation', { frame, isMainFrame: false, isSameDocument: false });
  assert.equal(await pending, null);
  finishCapture(await originalCapture({}));
  // Wait for the canceled write and its cleanup to finish before test teardown.
  await new Promise(done => setTimeout(done, 40));
  assert.deepEqual((await readdir(shots)).sort(), before);
});

test('larger screenshots use JPEG q85 with a JPEG q70 thumbnail', async () => {
  const { event, sender, frame, executions } = fixture();
  const qualities: number[] = [];
  const sizes: unknown[] = [];
  const image = { isEmpty: () => false, getSize: () => ({ width: 1600, height: 900 }),
    toPNG: () => Buffer.alloc(600 * 1024 + 1), toJPEG: (quality: number) => { qualities.push(quality); return Buffer.from('jpeg'); },
    resize: (size: unknown) => { sizes.push(size); return image; },
  };
  Object.assign(sender, { capturePage: async () => image });
  const pending = invoke('pick-page-target', event, { frameName: frame.name, frameRect });
  await new Promise<void>(done => setImmediate(done)); executions[0].done(pick());
  const result = await pending as { shot: { id: string; path: string } };
  assert.ok(result.shot.path.endsWith('.jpg')); assert.deepEqual(qualities, [85, 70]);
  assert.deepEqual(sizes, [{ width: 240, height: 135, quality: 'good' }]);
  assert.equal(await invoke('read-page-shot', event, result.shot.id), 'data:image/jpeg;base64,anBlZw==');
  await invoke('delete-page-shots', event, [result.shot.id]);
});

test('select-all page text only executes in the calling named direct preview frame', async () => {
  const { event, frame } = fixture(); let source = '';
  frame.executeJavaScript = async (value: string) => { source = value; return true; };
  assert.equal(await invoke('select-all-page-text', event, frame.name), true);
  assert.match(source, /selectNodeContents\(document\.body\)/);
  assert.equal(await invoke('select-all-page-text', event, 'tt-preview-otherone'), false);
});

test('preview context menu converts window coordinates to the offset iframe and ignores other frames', async () => {
  await registered;
  const sent: unknown[] = [];
  const mainFrame = { framesInSubtree: [] as unknown[], executeJavaScript: async () => ({ rect: { x: 100, y: 50, width: 800, height: 600 }, staticFrame: false }) };
  const frame = { parent: mainFrame, detached: false, name: 'tt-preview-abcdefgh', executeJavaScript: async (source: string) => {
    assert.match(source, /\{"x":40,"y":50\}/);
    return pick();
  } };
  const other = { parent: mainFrame, detached: false, name: 'tt-preview-otherone', executeJavaScript: async () => pick() };
  // Native positions are DIP; divide by page zoom before comparing with the trusted CSS iframe rect.
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, getZoomFactor: () => 1.25,
    mainFrame: Object.assign(mainFrame, { framesInSubtree: [frame] }),
    capturePage: async () => ({ isEmpty: () => true }), send: (_channel: string, value: unknown) => sent.push(value) });
  webContentsCreated?.({}, contents);
  contents.emit('context-menu', {}, { frame, x: 175, y: 125 });
  await new Promise(done => setImmediate(done)); await new Promise(done => setImmediate(done));
  assert.equal((sent[0] as { frameName: string }).frameName, frame.name);
  contents.emit('context-menu', {}, { frame: other, x: 175, y: 125 });
  await new Promise(done => setImmediate(done));
  assert.equal(sent.length, 1);
});

async function contextFixture(staticFrame = false) {
  await registered;
  const value = fixture(), sent: Array<{ staticFrame?: boolean; selectionText: string; pick?: { target: { text?: string }; shot?: { id: string } } }> = [];
  Object.assign(value.frame, { url: staticFrame ? 'about:srcdoc' : 'https://example.com/' });
  value.frame.executeJavaScript = async (source: string) => { value.executions.push({ source, done: () => {} }); return pick(); };
  Object.assign(value.sender.mainFrame, { executeJavaScript: async () => ({ rect: frameRect, staticFrame }) });
  const sender = Object.assign(value.sender, { send: (_channel: string, payload: (typeof sent)[number]) => sent.push(payload) });
  webContentsCreated?.({}, sender);
  return { ...value, sender, sent };
}

async function settleContexts(sender: EventEmitter) {
  for (let tries = 0; tries < 200 && sender.listenerCount('did-start-navigation'); tries++) await new Promise(done => setTimeout(done, 5));
  assert.equal(sender.listenerCount('did-start-navigation'), 0, 'completed context requests release navigation listeners');
  assert.equal(sender.listenerCount('did-frame-navigate'), 0);
}

test('saved srcdoc HTML sends a regular preview event without a live pick or screenshot', async () => {
  const { sender, frame, sent, executions, captureRects } = await contextFixture(true);
  sender.emit('context-menu', {}, { frame, x: 175, y: 125, selectionText: 'Saved HTML\nselected text\u0000' });
  await settleContexts(sender);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].staticFrame, true);
  assert.equal(sent[0].pick, undefined);
  assert.equal(sent[0].selectionText, 'Saved HTML\nselected text ');
  assert.equal(executions.length, 0, 'static preview bypasses the strict live HTTP page picker');
  assert.equal(captureRects.length, 0);
});

test('nested frames cannot imitate a direct preview frame for context menus or select-all', async () => {
  const { sender, frame, sent, executions } = await contextFixture();
  Object.assign(frame, { parent: {} });
  sender.emit('context-menu', {}, { frame, x: 175, y: 125 });
  await new Promise(done => setImmediate(done));
  assert.equal(sent.length, 0);
  assert.equal(executions.length, 0);
  assert.equal(await invoke('select-all-page-text', { sender, trusted: true }, frame.name), false);
});

test('navigation during a context capture drops the event and deletes its late screenshot', async () => {
  const { sender, frame, sent } = await contextFixture();
  const before = (await readdir(shots)).sort(), capture = sender.capturePage;
  let finish!: (image: Awaited<ReturnType<typeof capture>>) => void;
  sender.capturePage = () => new Promise(done => { finish = done; });
  sender.emit('context-menu', {}, { frame, x: 175, y: 125 });
  await new Promise(done => setImmediate(done));
  assert.equal(typeof finish, 'function');
  sender.emit('did-start-navigation', { frame, isMainFrame: false, isSameDocument: false });
  finish(await capture({}));
  await settleContexts(sender);
  assert.equal(sent.length, 0);
  assert.deepEqual((await readdir(shots)).sort(), before);
});

test('the latest preview right-click wins when earlier picker results finish later', async () => {
  const { sender, frame, sent } = await contextFixture();
  const pending: Array<(value: unknown) => void> = [];
  frame.executeJavaScript = () => new Promise(done => pending.push(done));
  sender.emit('context-menu', {}, { frame, x: 175, y: 125 });
  await new Promise(done => setImmediate(done));
  sender.emit('context-menu', {}, { frame, x: 185, y: 135 });
  await new Promise(done => setImmediate(done));
  assert.equal(pending.length, 2);
  const second = pick(); Object.assign(second.target, { text: 'Second element' });
  pending[1](second); pending[0](pick());
  await settleContexts(sender);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].pick?.target.text, 'Second element');
  if (sent[0].pick?.shot) await invoke('delete-page-shots', { sender, trusted: true }, [sent[0].pick.shot.id]);
});

test('oversized JPEG captures are downscaled before they are persisted', async () => {
  const { event, sender, frame, executions } = fixture();
  const sizes: Array<{ width: number; height: number }> = [];
  const image = (width: number, height: number) => ({
    isEmpty: () => false, getSize: () => ({ width, height }), toPNG: () => Buffer.alloc(600 * 1024 + 1),
    toJPEG: (quality: number) => Buffer.alloc(quality === 70 || width <= 1000 ? 1024 : 4 * 1024 * 1024 + 1),
    resize: (size: { width: number; height: number }) => { sizes.push(size); return image(size.width, size.height); },
  });
  Object.assign(sender, { capturePage: async () => image(1600, 900) });
  const pending = invoke('pick-page-target', event, { frameName: frame.name, frameRect });
  await new Promise<void>(done => setImmediate(done)); executions[0].done(pick());
  const result = await pending as { shot: { id: string; path: string; width: number; height: number } };
  assert.ok(result.shot.width < 1600 && result.shot.height < 900);
  assert.ok((await readFile(result.shot.path)).length <= 4 * 1024 * 1024);
  assert.ok(sizes.some(size => size.width < 1600 && size.height < 900));
  await invoke('delete-page-shots', event, [result.shot.id]);
});

test('validated picks capture zoomed bounds, downscale, store, read, and delete', async () => {
  const { event, frame, executions, captureRects, jpegQualities } = fixture();
  const pending = invoke('pick-page-target', event, { frameName: frame.name, frameRect });
  await new Promise<void>(done => setImmediate(done));
  executions[0].done(pick());
  const result = await pending as { shot: { id: string; path: string; width: number; height: number; thumbnail: string } };
  assert.deepEqual(captureRects, [{ x: 175, y: 188, width: 170, height: 54 }]);
  assert.deepEqual([result.shot.width, result.shot.height], [1600, 900]);
  assert.equal(result.shot.path, join(shots, `${result.shot.id}.png`));
  assert.equal(await readFile(result.shot.path, 'utf8'), 'png');
  assert.deepEqual(jpegQualities, [70]);
  assert.equal(result.shot.thumbnail, 'data:image/jpeg;base64,anBlZw==');
  assert.equal(await invoke('read-page-shot', event, result.shot.id), 'data:image/png;base64,cG5n');
  await invoke('delete-page-shots', event, [result.shot.id]);
  assert.equal(await invoke('read-page-shot', event, result.shot.id), undefined);
});

test('malformed picks fail before capturing, and tiny picks have no shot', async () => {
  const { event, frame, executions, captureRects } = fixture();
  const pending = invoke('pick-page-target', event, { frameName: frame.name, frameRect });
  await new Promise<void>(done => setImmediate(done));
  executions[0].done({ ...pick(), url: 'file:///private' });
  await assert.rejects(pending, /Invalid page URL/);
  const tiny = invoke('pick-page-target', event, { frameName: frame.name, frameRect });
  const raw = pick(); raw.target.rect.width = 0;
  await new Promise<void>(done => setImmediate(done));
  executions[1].done(raw);
  assert.equal('shot' in (await tiny as object), false);
  assert.equal(captureRects.length, 0);
});

test('shot access rejects traversal, symlinks, over-limit files, and invalid delete ids atomically', async () => {
  const { event } = fixture();
  await assert.rejects(invoke('read-page-shot', event, '../file'), /Invalid page shot id/);
  const large = randomUUID();
  await writeFile(join(shots, `${large}.png`), Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(invoke('read-page-shot', event, large), /size limit/);
  await assert.rejects(invoke('delete-page-shots', event, [freshId, '../file']), /Invalid page shot ids/);
  assert.equal(await readFile(join(shots, `${freshId}.jpg`), 'utf8'), 'fresh');
  const escaped = join(root, 'outside'); await mkdir(escaped);
  const dirLink = join(root, 'linked-profile'); await mkdir(dirLink);
  await symlink(escaped, join(dirLink, 'page-comments'), 'junction');
  profile = dirLink;
  try { await assert.rejects(invoke('read-page-shot', event, freshId), /directory escaped/); }
  finally { profile = root; }
  // File symlinks on Windows may require developer mode; directory junctions always work.
  const id = randomUUID();
  await symlink(escaped, join(shots, `${id}.png`), 'junction');
  await assert.rejects(invoke('read-page-shot', event, id), /Invalid page shot file/);
  await assert.rejects(invoke('delete-page-shots', event, [id]), /Invalid page shot file/);
});

test('startup cleanup removes only old UUID shot files', async () => {
  // Earlier async tests give the nonblocking cleanup time to finish.
  await assert.rejects(readFile(join(shots, `${oldId}.png`)), { code: 'ENOENT' });
  assert.equal(await readFile(join(shots, `${freshId}.jpg`), 'utf8'), 'fresh');
  assert.equal(await readFile(join(shots, 'unowned.txt'), 'utf8'), 'preserve');
});
