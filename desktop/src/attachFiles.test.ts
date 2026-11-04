import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ATTACH_FILES, MAX_ATTACH_INLINE_BYTES, attachmentDataUrlLength, attachmentImageMime, qaAttachPathsOverride, readAttachFiles, uploadAttachFile, validAttachPath } from './attachFiles.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { HostFilePickers, hostRevealTarget } from './hostFiles.js';
import { readHostPageShot, reviewShotSession } from './remoteFiles.js';
import { MAX_CHAT_IMAGES } from '@threadterm/protocol';

const png = 'data:image/png;base64,AQID';
const regular = () => ({ isFile: () => true, size: 3 });
const directory = () => ({ isFile: () => false, size: 0 });
const readBuffer = (buffer: Buffer) => async () => buffer;
const statSize = (size: number | ((path: string) => number)) => async (path: string) => ({ isFile: () => true, size: typeof size === 'function' ? size(path) : size });

test('review screenshot session lookup matches canonical host roots without selecting a sibling worktree', () => {
  const snapshot = { projects: [{ id: 'p', path: 'Z:/Host' }], sessions: [{ id: 'tree', projectId: 'p', worktreePath: 'Z:/Tree' }, { id: 'main', projectId: 'p' }] };
  assert.equal(reviewShotSession(snapshot, 'p', '\\\\?\\z:\\HOST'), 'main');
  assert.equal(reviewShotSession(snapshot, 'p', 'z:/tree/'), 'tree');
  assert.equal(reviewShotSession(snapshot, 'p', 'z:/other'), undefined);
  snapshot.projects[0]!.path = '\\\\?\\UNC\\server\\share';
  assert.equal(reviewShotSession(snapshot, 'p', '\\\\SERVER\\SHARE'), 'main');
  snapshot.projects[0]!.path = '/Host';
  assert.equal(reviewShotSession(snapshot, 'p', '/host'), undefined);
});

test('host picker completions are sender-bound and closing the sender cancels its dialog', async () => {
  const picker = new HostFilePickers(), events = new EventEmitter();
  let request!: { id: string; mode: string };
  const sender = { id: 7, send: (_channel: string, value: unknown) => { request = value as typeof request; }, once: events.once.bind(events), removeListener: events.removeListener.bind(events) };
  const result = picker.choose(sender, 'directory'); assert.equal(request.mode, 'directory');
  assert.throws(() => picker.complete(8, request.id, ['Z:/host']), /another window/);
  picker.complete(7, request.id, ['Z:/host']); assert.deepEqual(await result, ['Z:/host']);
  const cancelled = picker.choose(sender, 'files'); events.emit('destroyed'); assert.deepEqual(await cancelled, []);
});

test('remote Reveal uses the host scope without probing the client filesystem', async () => {
  const runtime = { request: async (method: string, value: unknown) => { assert.equal(method, 'filesystem.resolve'); assert.deepEqual(value, { sessionId: 'host-chat', path: 'src/host-only.log' }); return { projectId: 'host', worktreePath: 'Z:/missing-on-client/host', path: 'src/host-only.log' }; } } as unknown as Parameters<typeof hostRevealTarget>[0];
  const target = await hostRevealTarget(runtime, 'host-chat', 'src/host-only.log');
  assert.equal(target.path, join('Z:/missing-on-client/host', 'src')); assert.equal(target.selectedPath, join('Z:/missing-on-client/host', 'src/host-only.log'));
});

test('remote Reveal can select a large or deleted file without reading its contents', async () => {
  const runtime = { request: async (method: string) => {
    if (method === 'filesystem.resolve') throw Object.assign(new Error('file_too_large'), { code: 'file_too_large' });
    assert.equal(method, 'runtime.snapshot'); return { projects: [{ id: 'p', path: 'Z:/host-only' }], sessions: [{ id: 's', projectId: 'p' }] };
  } } as unknown as Parameters<typeof hostRevealTarget>[0];
  assert.equal((await hostRevealTarget(runtime, 's', 'large.html')).selectedPath, join('Z:/host-only', 'large.html'));
  await assert.rejects(hostRevealTarget(runtime, 's', '../escape.html'), /outside/);
});

test('another controller screenshot reader assembles bounded host chunks', async () => {
  const bytes = Buffer.alloc(1024 * 1024 + 3, 1); let calls = 0;
  const runtime = { request: async (_method: string, p: { offset: number; limit: number }) => { calls++; const chunk = bytes.subarray(p.offset, p.offset + p.limit); return { assetId: 'id', hostPath: 'Z:/host/shot.png', name: 'shot.png', size: bytes.length, offset: p.offset, chunk: chunk.toString('base64'), eof: p.offset + chunk.length === bytes.length }; } } as unknown as Parameters<typeof readHostPageShot>[0];
  const image = await readHostPageShot(runtime, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(Buffer.from(image!.split(',')[1]!, 'base64'), bytes); assert.equal(calls, 2);
});

test('remote file upload sends bounded chunks with one transfer identity and returns the host path', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tt-remote-attach-'));
  try {
    const path = join(folder, 'client.log'), bytes = Buffer.alloc(2 * 1024 * 1024 + 13, 97), chunks: Buffer[] = [];
    await writeFile(path, bytes);
    const ids = new Set<string>(); let offset = 0;
    const runtime = { request: async (method: string, p: { uploadId: string; offset: number; chunk: string; final: boolean }) => {
      assert.equal(method, 'attachment.upload'); assert.equal(p.offset, offset); ids.add(p.uploadId);
      const chunk = Buffer.from(p.chunk, 'base64'); assert.ok(chunk.length <= 1024 * 1024); chunks.push(chunk); offset += chunk.length;
      return { offset, ...(p.final ? { assetId: 'asset', hostPath: 'Z:/host/assets/client.log' } : {}) };
    } } as unknown as Parameters<typeof uploadAttachFile>[0];
    assert.deepEqual(await uploadAttachFile(runtime, 'host-session', path), { assetId: 'asset', hostPath: 'Z:/host/assets/client.log' });
    assert.equal(ids.size, 1); assert.equal(chunks.length, 3); assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.deepEqual(await readAttachFiles([path]), [{ path, name: 'client.log' }], 'local attachment remains a client-path chip');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('validAttachPath accepts only absolute, control-free paths', () => {
  assert.equal(validAttachPath('C:\\work\\src\\main.ts'), true);
  assert.equal(validAttachPath('/home/me/notes.md'), true);
  assert.equal(validAttachPath('relative/path.ts'), false);
  assert.equal(validAttachPath(''), false);
  assert.equal(validAttachPath('C:\\work\\bad\u0000name.ts'), false);
  assert.equal(validAttachPath('C:\\work\\' + 'x'.repeat(4096)), false);
  assert.equal(validAttachPath(42), false);
  assert.equal(validAttachPath(undefined), false);
});

test('attachmentImageMime maps the composer-supported image formats', () => {
  assert.equal(attachmentImageMime('photo.png'), 'image/png');
  assert.equal(attachmentImageMime('scan.JPEG'), 'image/jpeg');
  assert.equal(attachmentImageMime('anim.gif'), 'image/gif');
  assert.equal(attachmentImageMime('shot.webp'), 'image/webp');
  assert.equal(attachmentImageMime('main.ts'), undefined);
});

test('the inline budget counts the base64 data URL, not the raw size', () => {
  const threeAndAHalfMiB = Math.round(3.5 * 1024 * 1024);
  assert.ok(threeAndAHalfMiB <= 4 * 1024 * 1024, 'raw size alone would look acceptable');
  assert.ok(attachmentDataUrlLength('image/png', threeAndAHalfMiB) > MAX_ATTACH_INLINE_BYTES, 'but its data URL does not fit the composer');
});

test('readAttachFiles inlines small images and keeps the rest as paths', async () => {
  const files = await readAttachFiles(
    ['C:\\work\\shot.png', 'C:\\work\\src\\main.ts', 'C:\\work\\missing.md', 'C:\\work\\folder'],
    readBuffer(Buffer.from([1, 2, 3])),
    async path => {
      if (path.endsWith('missing.md')) throw new Error('ENOENT');
      if (path.endsWith('folder')) return directory();
      return regular();
    },
  );
  assert.deepEqual(files, [
    { path: 'C:\\work\\shot.png', name: 'shot.png', dataUrl: png },
    { path: 'C:\\work\\src\\main.ts', name: 'main.ts' },
  ]);
});

test('readAttachFiles leaves oversized or unreadable images as path-only attachments', async () => {
  const files = await readAttachFiles(
    ['C:\\work\\huge.png', 'C:\\work\\broken.png'],
    async () => { throw new Error('EACCES'); },
    statSize(path => (path.includes('huge') ? MAX_ATTACH_INLINE_BYTES : 10)),
  );
  assert.deepEqual(files, [
    { path: 'C:\\work\\huge.png', name: 'huge.png' },
    { path: 'C:\\work\\broken.png', name: 'broken.png' },
  ]);
});

test('readAttachFiles does not inline an image whose data URL exceeds the composer budget', async () => {
  const big = Math.round(3.5 * 1024 * 1024);
  let reads = 0;
  const files = await readAttachFiles(
    ['C:\\work\\big.png', 'C:\\work\\small.png'],
    async () => { reads += 1; return Buffer.from([1, 2, 3]); },
    statSize(path => (path.includes('big') ? big : 3)),
  );
  assert.deepEqual(files, [
    { path: 'C:\\work\\big.png', name: 'big.png' },
    { path: 'C:\\work\\small.png', name: 'small.png', dataUrl: png },
  ]);
  assert.equal(reads, 1, 'the rejected image is never read');
});

test('readAttachFiles inlines at most MAX_CHAT_IMAGES images and keeps the rest path-only', async () => {
  const paths = Array.from({ length: 5 }, (_, index) => `C:\\work\\shot-${index}.png`);
  const files = await readAttachFiles(paths, readBuffer(Buffer.from([1, 2, 3])), statSize(3));
  assert.equal(files.filter(file => file.dataUrl).length, MAX_CHAT_IMAGES);
  assert.equal(files.length, 5);
  assert.equal(files[4]!.dataUrl, undefined, 'the fifth image stays a file chip');
});

test('readAttachFiles bounds the aggregate inlined bytes per pick', async () => {
  // 2 MiB raw → a ~2.67 MiB data URL; only one fits the 4 MiB total.
  const twoMiB = 2 * 1024 * 1024;
  const files = await readAttachFiles(
    ['C:\\work\\a.png', 'C:\\work\\b.png', 'C:\\work\\c.png'],
    async () => Buffer.alloc(twoMiB),
    statSize(twoMiB),
  );
  const inlined = files.filter(file => file.dataUrl);
  assert.equal(inlined.length, 1);
  assert.equal(files.filter(file => !file.dataUrl).length, 2);
});

test('the QA attach override is ignored in a packaged build', () => {
  assert.deepEqual(qaAttachPathsOverride('C:\\a.png;C:\\b.txt', false), ['C:\\a.png', 'C:\\b.txt']);
  assert.equal(qaAttachPathsOverride('C:\\a.png', true), undefined, 'a packaged build ignores the env override');
  assert.equal(qaAttachPathsOverride(undefined, false), undefined);
  assert.equal(qaAttachPathsOverride('', false), undefined);
});

test('readAttachFiles caps the returned batch', async () => {
  const paths = Array.from({ length: MAX_ATTACH_FILES + 5 }, (_, index) => `/tmp/file-${index}.md`);
  assert.equal((await readAttachFiles(paths, readBuffer(Buffer.alloc(0)), statSize(3))).length, MAX_ATTACH_FILES);
});
