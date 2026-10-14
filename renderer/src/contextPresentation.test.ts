import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { createRequire } from 'node:module';
Object.assign(globalThis, { require: createRequire(import.meta.url) });
const { renderToStaticMarkup } = await import('react-dom/server');
import { ContextMessage, ContextQueueBadge, ContextTray } from './components/ContextTray';
import { MessageMentionText } from './components/MessageMentionText';
import { serializeContext, serializeMentionedContext, type ContextItem } from './chatContext';
import type { MentionEntry } from './inlineMentions';
import { contextError } from './contextErrors';

const items: ContextItem[] = [{ kind: 'terminal', id: 'build', sessionTitle: 'build', lines: 1, text: 'PRIVATE OUTPUT WALL' }, { kind: 'file', id: 'file', path: 'src/cart.ts', startLine: 12, endLine: 20 }];

test('submitted and pending context messages show operable chips and instructions without raw output', () => {
  const text = serializeContext(items, 'Review this');
  const html = renderToStaticMarkup(createElement(ContextMessage, { text, zh: false, children: value => createElement('p', null, value) }));
  assert.match(html, /context-transcript-row/);
  assert.match(html, /context-chip/);
  assert.match(html, /Review this/);
  assert.match(html, /title="Terminal output/);
  assert.doesNotMatch(html, /PRIVATE OUTPUT WALL|ThreadTerm message|ThreadTerm context/);
  assert.doesNotMatch(html, /context-chip-remove/);
});

test('empty trays render nothing and budget hints appear only near the limits', () => {
  const render = (value: ContextItem[], text = '') => renderToStaticMarkup(createElement(ContextTray, { items: value, text, zh: false, onRemove: () => {} }));
  assert.equal(render([]), '');
  assert.doesNotMatch(render(items), /context-budget/);
  assert.match(render(items, 'x'.repeat(100 * 1024)), /KiB of 128 KiB/);
  assert.match(render(items), /aria-label="Remove context:/);
});

test('an over-budget draft reports an over-limit readout instead of zero bytes', () => {
  const over: ContextItem[] = Array.from({ length: 12 }, (_, index) => ({ kind: 'quote', id: `q${index}`, sourceTitle: `Quote ${index}`, text: 'body' }));
  const mentions: MentionEntry[] = [{ token: '@cart.ts', item: { kind: 'file', id: 'file:src/cart.ts', path: 'src/cart.ts' } }];
  const html = renderToStaticMarkup(createElement(ContextTray, { items: over, text: '@cart.ts', zh: false, onRemove: () => {}, mentions }));
  assert.match(html, /13\/12/);
  assert.match(html, /over 128 KiB/);
  assert.doesNotMatch(html, /0 KiB/);
});

test('queue context badge and limit errors are localized without exposing serialized context', () => {
  const html = renderToStaticMarkup(createElement(ContextQueueBadge, { text: serializeContext(items, 'instructions'), zh: true }));
  assert.match(html, /2 项上下文/);
  assert.doesNotMatch(html, /PRIVATE OUTPUT WALL|ThreadTerm context/);
  assert.match(contextError(new Error('Context exceeds 128 KiB.'), true), /128 KiB/);
  assert.match(contextError(new Error('Attach at most 12 context items.'), true), /12/);
  assert.equal(contextError(new Error('Invalid / 无效'), false), 'Invalid');
});

test('sent-message badge tooltips use the localized context title', () => {
  const message = serializeMentionedContext({ trayItems: [], active: [{ token: '@cart.ts', item: { kind: 'file', id: 'file:src/cart.ts', path: 'src/cart.ts' } }] }, 'see @cart.ts');
  const render = (zh: boolean) => renderToStaticMarkup(createElement(ContextMessage, {
    text: message, zh,
    children: (value, badges) => createElement(MessageMentionText, { text: value, badges, zh }),
  }));
  assert.match(render(false), /title="File: src\/cart\.ts"/);
  assert.match(render(true), /title="文件： src\/cart\.ts"/);
});
