import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serializeContext, parseContext } from './chatContext';
import { contextQueueText } from './contextQueue';
import { queueItemSummary } from './chatQueue';

test('queue summaries and edits keep context separate from the instructions', () => {
  const original = serializeContext([{ kind: 'file', id: 'file', path: 'src/cart.ts', startLine: 12, endLine: 20 }], 'Review cart');
  assert.equal(queueItemSummary({ text: original, images: [] }), 'Review cart');
  const next = contextQueueText(original, 'New instructions');
  assert.deepEqual(parseContext(next)?.items, parseContext(original)?.items);
  assert.equal(parseContext(next)?.text, 'New instructions');
  assert.equal(queueItemSummary({ text: contextQueueText(original, ''), images: [] }), 'Context only');
  assert.equal(contextQueueText('old', 'new'), 'new');
  assert.throws(() => contextQueueText(original, '汉'.repeat(45000)), /128 KiB/);
});
