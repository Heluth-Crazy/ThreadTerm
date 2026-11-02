import assert from 'node:assert/strict';
import test from 'node:test';
import { replayRetentionBoundary, retainedOutputTrimmedNote } from './terminalReplayRetention.js';

test('replay begins at the retained cursor and marks only a pruned prefix as trimmed', () => {
  assert.deepEqual(replayRetentionBoundary({ fromCursor: 0 }, 256), { cursor: 0, trimmed: false });
  assert.deepEqual(replayRetentionBoundary({ fromCursor: 128 }, 256), { cursor: 128, trimmed: true });
});

test('replay rejects a retained cursor outside its captured output boundary', () => {
  assert.throws(() => replayRetentionBoundary({ fromCursor: 257 }, 256), /invalid retained output start/);
  assert.throws(() => replayRetentionBoundary({ fromCursor: -1 }, 256), /invalid retained output start/);
});

test('the retained-prefix notice names the active cap without misstating ended retention', () => {
  assert.equal(retainedOutputTrimmedNote(false, true), 'Older output was trimmed. This terminal keeps its newest 128 MB.');
  assert.equal(retainedOutputTrimmedNote(true, true), '较早的输出已被清理，此终端保留最近 128 MB。');
  assert.equal(retainedOutputTrimmedNote(false, false), 'Older output was trimmed.');
  assert.equal(retainedOutputTrimmedNote(true, false), '较早的输出已被清理。');
});
