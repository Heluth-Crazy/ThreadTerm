import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ATTACH_FILES, MAX_ATTACH_IMAGE_BYTES, attachmentImageMime, readAttachFiles, validAttachPath } from './attachFiles.js';

const png = 'data:image/png;base64,AQID';
const regular = () => ({ isFile: () => true, size: 3 });
const directory = () => ({ isFile: () => false, size: 0 });

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

test('readAttachFiles inlines small images and keeps the rest as paths', () => {
  const files = readAttachFiles(
    ['C:\\work\\shot.png', 'C:\\work\\src\\main.ts', 'C:\\work\\missing.md', 'C:\\work\\folder'],
    () => Buffer.from([1, 2, 3]),
    path => {
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

test('readAttachFiles leaves oversized or unreadable images as path-only attachments', () => {
  const files = readAttachFiles(
    ['C:\\work\\huge.png', 'C:\\work\\broken.png'],
    () => { throw new Error('EACCES'); },
    path => ({ isFile: () => true, size: path.includes('huge') ? MAX_ATTACH_IMAGE_BYTES + 1 : 10 }),
  );
  assert.deepEqual(files, [
    { path: 'C:\\work\\huge.png', name: 'huge.png' },
    { path: 'C:\\work\\broken.png', name: 'broken.png' },
  ]);
});

test('readAttachFiles caps the returned batch', () => {
  const paths = Array.from({ length: MAX_ATTACH_FILES + 5 }, (_, index) => `/tmp/file-${index}.md`);
  assert.equal(readAttachFiles(paths, () => Buffer.alloc(0), regular).length, MAX_ATTACH_FILES);
});
