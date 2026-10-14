import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serializeContext, serializeMentionedContext, parseContext } from './chatContext';
import type { MentionEntry } from './inlineMentions';
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

test('a queue edit keeps the mentions envelope and changes only the instructions', () => {
  const catalogue: MentionEntry[] = [
    { token: '@cart.ts', item: { kind: 'file', id: 'file:src/cart.ts', path: 'src/cart.ts' } },
    { token: '@checkout.ts', item: { kind: 'file', id: 'file:src/checkout.ts', path: 'src/checkout.ts' } },
  ];
  const original = serializeMentionedContext({ trayItems: [], active: catalogue, workspaceRoot: 'C:/repo' }, 'review @cart.ts and @checkout.ts');
  const edited = contextQueueText(original, 'review @cart.ts only');
  assert.match(edited, /\[ThreadTerm message; mentions v1 \{"@cart.ts":1,"@checkout.ts":2\}\]/);
  assert.equal(parseContext(edited)?.items.length, 2, 'both accepted blocks stay in the envelope');
  assert.equal(parseContext(edited)?.items[1]?.inlineToken, '@checkout.ts');
  assert.equal(parseContext(edited)?.text, 'review @cart.ts only');
});
