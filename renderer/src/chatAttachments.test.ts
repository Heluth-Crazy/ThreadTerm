import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentFileName, attachmentImageMime, fileAttachmentItem, isAttachmentImage, partitionAttachedFiles } from './chatAttachments';
import { MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGES } from './chatImages';

const image = 'data:image/png;base64,AAAA';
const id = (path: string) => `id:${path}`;

test('attachment names and image mime types come from the path', () => {
  assert.equal(attachmentFileName('C:\\work\\src\\main.ts'), 'main.ts');
  assert.equal(attachmentFileName('/home/me/photo.PNG'), 'photo.PNG');
  assert.equal(attachmentImageMime('photo.PNG'), 'image/png');
  assert.equal(attachmentImageMime('scan.jpeg'), 'image/jpeg');
  assert.equal(attachmentImageMime('anim.webp'), 'image/webp');
  assert.equal(attachmentImageMime('notes.md'), undefined);
  assert.equal(isAttachmentImage('icon.gif'), true);
  assert.equal(isAttachmentImage('archive.tar.gz'), false);
});

test('file attachments become file context chips', () => {
  assert.deepEqual(fileAttachmentItem('src/main.ts', 'id-1'), { kind: 'file', id: 'id-1', path: 'src/main.ts' });
});

test('partitionAttachedFiles sends images to the image path and the rest to file chips', () => {
  const plan = partitionAttachedFiles([
    { path: 'C:\\work\\shot.png', name: 'shot.png', dataUrl: image },
    { path: 'C:\\work\\src\\main.ts', name: 'main.ts' },
    // An image that was too large to inline stays a file chip.
    { path: 'C:\\work\\huge.png', name: 'huge.png' },
  ], [], true, id);
  assert.deepEqual(plan.images, [image]);
  assert.deepEqual(plan.files, [
    { kind: 'file', id: 'id:C:\\work\\src\\main.ts', path: 'C:\\work\\src\\main.ts' },
    { kind: 'file', id: 'id:C:\\work\\huge.png', path: 'C:\\work\\huge.png' },
  ]);
  assert.equal(plan.imagesAsFiles, 0);
});

test('partitionAttachedFiles turns an inlined image the composer rejects into a file chip', () => {
  const picked = Array.from({ length: MAX_CHAT_IMAGES + 1 }, (_, index) => ({ path: `C:\\work\\shot-${index}.png`, name: `shot-${index}.png`, dataUrl: image }));
  const plan = partitionAttachedFiles(picked, [], true, path => `id:${path}`);
  assert.equal(plan.images.length, MAX_CHAT_IMAGES);
  assert.equal(plan.imagesAsFiles, 1);
  assert.deepEqual(plan.files, [{ kind: 'file', id: `id:${picked[4]!.path}`, path: picked[4]!.path }]);
});

test('partitionAttachedFiles falls back to file chips when the receiver cannot take images', () => {
  const plan = partitionAttachedFiles([
    { path: 'C:\\work\\shot.png', name: 'shot.png', dataUrl: image },
    { path: 'C:\\work\\notes.md', name: 'notes.md' },
  ], [], false, id);
  assert.deepEqual(plan.images, []);
  assert.equal(plan.imagesAsFiles, 1);
  assert.deepEqual(plan.files.map(item => item.path), ['C:\\work\\notes.md', 'C:\\work\\shot.png']);
});

test('partitionAttachedFiles budgets around images already in the composer', () => {
  const existing = Array.from({ length: MAX_CHAT_IMAGES - 1 }, () => image);
  const plan = partitionAttachedFiles([
    { path: 'C:\\work\\first.png', name: 'first.png', dataUrl: image },
    { path: 'C:\\work\\second.png', name: 'second.png', dataUrl: image },
  ], existing, true, id);
  assert.deepEqual(plan.images, [image]);
  assert.equal(plan.imagesAsFiles, 1);
  assert.deepEqual(plan.files.map(item => item.path), ['C:\\work\\second.png']);
});

test('partitionAttachedFiles respects the data-URL byte budget', () => {
  const large = `data:image/png;base64,${'A'.repeat(MAX_CHAT_IMAGE_BYTES)}`;
  const plan = partitionAttachedFiles([
    { path: 'C:\\work\\large.png', name: 'large.png', dataUrl: large },
    { path: 'C:\\work\\small.png', name: 'small.png', dataUrl: image },
  ], [], true, id);
  assert.deepEqual(plan.images, [image], 'the large image is rejected but the small one still fits');
  assert.equal(plan.imagesAsFiles, 1);
  assert.deepEqual(plan.files.map(item => item.path), ['C:\\work\\large.png']);
});
