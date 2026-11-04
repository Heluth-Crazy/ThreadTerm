import test from 'node:test';
import assert from 'node:assert/strict';
import { METHODS, PROTOCOL_CONTRACT, validateRequest, validateResult } from './index.ts';

test('contract 19 host files and attachment methods are additive and bounded', () => {
  assert.equal(PROTOCOL_CONTRACT, 19);
  for (const method of ['filesystem.browse', 'filesystem.preview.read', 'attachment.upload', 'attachment.read']) assert.ok(METHODS.includes(method));
  validateRequest('filesystem.browse', {});
  validateRequest('filesystem.browse', { path: 'Z:/host' });
  validateRequest('filesystem.preview.read', { projectId: 'p', path: 'index.html', offset: 0, limit: 1024 * 1024 });
  const upload = { uploadId: '11111111-1111-4111-8111-111111111111', sessionId: 's', name: 'log.txt', size: 3, offset: 0, chunk: 'YWJj', final: true };
  validateRequest('attachment.upload', upload);
  validateRequest('attachment.read', { assetId: upload.uploadId });
  assert.throws(() => validateRequest('filesystem.preview.read', { projectId: 'p', path: 'x', offset: -1, limit: 1 }));
  assert.throws(() => validateRequest('attachment.read', { assetId: 'a', limit: 1024 * 1024 + 1 }));
  assert.throws(() => validateRequest('attachment.upload', { ...upload, size: 256 * 1024 * 1024 + 1 }));
  validateResult('filesystem.browse', { entries: [], truncated: false });
  validateResult('filesystem.preview.read', { path: 'Z:/host/x', size: 3, offset: 0, fingerprint: 'f', chunk: 'YWJj', eof: true });
  validateResult('attachment.upload', { assetId: upload.uploadId, hostPath: 'Z:/host/a', offset: 3 });
});
