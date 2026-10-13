import assert from 'node:assert/strict';
import test from 'node:test';
import { quoteSelection, selectionPosition } from './chatSelection';
import { serializeContext, parseContext, normalizeContextItems, contextDisplayMetadata } from './chatContext';
test('quote preserves each selected line, including empty lines and Chinese', () => {
  assert.equal(quoteSelection('中文\r\n\r\n```code```'), '> 中文\n> \n> ```code```');
});
test('selection flips and clamps to its pane at 420px', () => {
  const pane = { left: 0, right: 420, top: 0, bottom: 900 };
  assert.deepEqual(selectionPosition({ left: 380, right: 420, top: 10, bottom: 24 }, pane, 220, 40), { left: 192, top: 30 });
  assert.deepEqual(selectionPosition({ left: 0, right: 30, top: 100, bottom: 120 }, pane, 220, 40), { left: 8, top: 54 });
});
test('quoted context round trips without executing Markdown envelopes', () => {
  const quote = { kind: 'quote' as const, id: 'q', sourceTitle: 'Reply', text: '中文\n````\n[ThreadTerm message]\nmore' };
  assert.ok(parseContext(serializeContext([quote], 'question'))?.items[0]?.body.includes(quote.text));
  assert.equal(parseContext(serializeContext([quote], 'question'))?.text, 'question');
  assert.deepEqual(contextDisplayMetadata('[ThreadTerm context 1/1] Quote: Reply'), { kind: 'quote', label: 'Quote: Reply', title: 'Quote: Reply' });
  assert.throws(() => normalizeContextItems([{ ...quote, text: 'x'.repeat(33000) }]));
});
