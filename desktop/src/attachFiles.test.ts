import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ATTACH_FILES, MAX_ATTACH_INLINE_BYTES, attachmentDataUrlLength, attachmentImageMime, qaAttachPathsOverride, readAttachFiles, validAttachPath } from './attachFiles.js';
import { MAX_CHAT_IMAGES } from '@threadterm/protocol';

const png = 'data:image/png;base64,AQID';
const regular = () => ({ isFile: () => true, size: 3 });
const directory = () => ({ isFile: () => false, size: 0 });
const readBuffer = (buffer: Buffer) => async () => buffer;
const statSize = (size: number | ((path: string) => number)) => async (path: string) => ({ isFile: () => true, size: typeof size === 'function' ? size(path) : size });

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
