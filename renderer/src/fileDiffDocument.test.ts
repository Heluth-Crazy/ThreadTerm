import assert from 'node:assert/strict';
import test from 'node:test';
import type { FileDocument, GitDiff } from '@threadterm/protocol';
import { readDiffDocument } from './fileDiffDocument';

const deleted: GitDiff = { path: 'removed.ts', staged: false, oldText: 'export const old = 1;\n', newText: '', binary: false, fingerprint: 'gone', deleted: true };

test('a missing tracked deletion opens a readonly document so its diff can load', async () => {
  let requested = false;
  const value = await readDiffDocument('removed.ts', async () => { throw new Error('canonicalizing requested path'); }, async () => { requested = true; return deleted; });
  assert.equal(requested, true);
  assert.deepEqual(value, { path: 'removed.ts', content: '', fingerprint: 'gone', readonly: true, size: 0, modifiedAt: '', diffOnly: true });
});

test('ordinary files preserve the disk document and make no diff probe', async () => {
  const doc: FileDocument = { path: 'exists.ts', content: 'live', fingerprint: 'live', readonly: false, size: 4, modifiedAt: 'now' };
  assert.equal(await readDiffDocument(doc.path, async () => doc, async () => { throw Error('unexpected diff probe'); }), doc);
});

test('non-deletions and diff failures retain the original read error', async () => {
  const error = Error('read denied');
  await assert.rejects(readDiffDocument('file', async () => { throw error; }, async () => ({ ...deleted, deleted: false })), value => value === error);
  await assert.rejects(readDiffDocument('file', async () => { throw error; }, async () => { throw Error('git unavailable'); }), value => value === error);
});

test('a binary diff opens its readonly binary surface without reading a text document', async () => {
  const value = await readDiffDocument('image.png', async () => { throw Error('binary_file'); }, async () => ({ ...deleted, path: 'image.png', binary: true, deleted: false }));
  assert.equal(value.readonly, true);
  assert.equal(value.content, '');
});
