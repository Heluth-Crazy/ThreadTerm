import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDraftWriter} from '../renderer/src/chatDraft';

test('conflicting drafts remain blocked until explicitly reconciled, then saving recovers', async () => {
  let calls = 0;
  const revisions: number[] = [];
  const writer = createDraftWriter({text: 'old', revision: 1}, async (text, revision) => {
    calls++; revisions.push(revision);
    if (calls === 1) throw new Error('revision_conflict');
    return {text, revision: revision + 1};
  });
  await assert.rejects(writer.write('local'), /revision_conflict/);
  await assert.rejects(writer.write('newer local'), /revision_conflict/);
  assert.equal(calls, 1);
  await writer.reset({text: 'remote', revision: 5});
  await writer.write('newer local');
  await writer.write('newer local');
  assert.deepEqual(revisions, [1, 5]);
});

test('rapid edits are serialized against the revision returned by each prior write', async () => {
  const revisions: number[] = [];
  const writer = createDraftWriter({text: '', revision: 0}, async (text, revision) => {
    await new Promise(resolve => setTimeout(resolve, 2));
    revisions.push(revision);
    return {text, revision: revision + 1};
  });
  await Promise.all([writer.write('a'), writer.write('ab'), writer.write('中文')]);
  assert.deepEqual(revisions, [0, 1, 2]);
});
