import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentFileName, attachmentImageMime, fileAttachmentItem, isAttachmentImage, partitionAttachedFiles } from './chatAttachments';

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
  const { images, files } = partitionAttachedFiles([
    { path: 'C:\\work\\shot.png', name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' },
    { path: 'C:\\work\\src\\main.ts', name: 'main.ts' },
    // An image that was too large to inline stays a file chip.
    { path: 'C:\\work\\huge.png', name: 'huge.png' },
  ], path => `id:${path}`);
  assert.deepEqual(images, ['data:image/png;base64,AAAA']);
  assert.deepEqual(files, [
    { kind: 'file', id: 'id:C:\\work\\src\\main.ts', path: 'C:\\work\\src\\main.ts' },
    { kind: 'file', id: 'id:C:\\work\\huge.png', path: 'C:\\work\\huge.png' },
  ]);
});
