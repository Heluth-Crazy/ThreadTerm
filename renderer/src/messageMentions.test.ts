import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContext, serializeMentionedContext, type ContextItem } from './chatContext';
import { highlightSegments, type MentionEntry } from './inlineMentions';
import { layoutMessageMentions, parseMessageMentions, createMessageMentionsMemo } from './messageMentions';

const fileItem = (path: string): ContextItem => ({ kind: 'file', id: `file:${path}`, path });
const fileEntry = (token: string, path: string): MentionEntry => ({ token, item: { kind: 'file', id: `file:${path}`, path } });

function resolve(body: string, trayItems: ContextItem[], active: MentionEntry[]) {
  const message = serializeMentionedContext({ trayItems, active }, body);
  const parsed = parseContext(message);
  assert.ok(parsed, `envelope parses: ${body}`);
  return { message, parsed, layout: layoutMessageMentions(parsed) };
}

test('a legacy message renders exactly as before: chips only, no badge', () => {
  const message = serializeMentionedContext({ trayItems: [fileItem('src/cart.ts')], active: [] }, 'Please check @cart.ts');
  const parsed = parseContext(message);
  assert.ok(parsed);
  const layout = layoutMessageMentions(parsed);
  assert.equal(layout.badges.length, 0);
  assert.equal(layout.chipItems.length, 1);
  assert.equal(layout.chipItems[0]!.inlineToken, undefined);
  assert.equal(parsed.text, 'Please check @cart.ts');
});

test('a v1 map turns its winning token into a badge and drops the duplicate chip', () => {
  const { layout } = resolve('Please check @cart.ts now', [fileItem('src/cart.ts')], [fileEntry('@cart.ts', 'src/cart.ts')]);
  assert.equal(layout.chipItems.length, 0);
  assert.deepEqual(layout.badges.map(badge => ({ start: badge.start, end: badge.end, token: badge.token, kind: badge.kind, label: badge.label, title: badge.title })), [
    { start: 13, end: 21, token: '@cart.ts', kind: 'file', label: 'cart.ts', title: 'File: src/cart.ts' },
  ]);
});

test('the whole map resolves once: the longer token wins and the loser keeps its chip', () => {
  const { layout } = resolve('see @a.ts here', [fileItem('src/a'), fileItem('src/a.ts')], [fileEntry('@a', 'src/a'), fileEntry('@a.ts', 'src/a.ts')]);
  assert.equal(layout.badges.length, 1);
  assert.equal(layout.badges[0]!.token, '@a.ts');
  assert.equal(layout.chipItems.length, 1);
  assert.equal(layout.chipItems[0]!.header, '[ThreadTerm context 1/2] File: src/a');
});

test('a mapped token missing from the text keeps its fallback chip', () => {
  const { layout } = resolve('review cart.ts only', [fileItem('src/checkout.ts')], [fileEntry('@checkout.ts', 'src/checkout.ts')]);
  assert.equal(layout.badges.length, 0);
  assert.equal(layout.chipItems.length, 1);
});

test('a repeated token badges every occurrence while one chip is removed', () => {
  const { layout } = resolve('@cart.ts and again @cart.ts', [fileItem('src/cart.ts')], [fileEntry('@cart.ts', 'src/cart.ts')]);
  assert.equal(layout.badges.length, 2);
  assert.equal(layout.chipItems.length, 0);
});

test('plain runs between badges stay byte-identical for FileLinkedText', () => {
  const body = 'src/other.ts then @cart.ts and src/more.ts';
  const { layout } = resolve(body, [fileItem('src/cart.ts')], [fileEntry('@cart.ts', 'src/cart.ts')]);
  const segments = highlightSegments(body, layout.badges);
  assert.deepEqual(segments.map(segment => segment.text), ['src/other.ts then ', '@cart.ts', ' and src/more.ts']);
  assert.equal(segments.map(segment => segment.text).join(''), body);
});

test('resolution never rewrites the user text used for plain-text copy', () => {
  const body = 'Please check @cart.ts and src/other.ts.';
  const { parsed, layout } = resolve(body, [fileItem('src/cart.ts')], [fileEntry('@cart.ts', 'src/cart.ts')]);
  assert.equal(parsed.text, body);
  assert.equal(highlightSegments(parsed.text, layout.badges).map(segment => segment.text).join(''), body);
});

test('a mention wrapped in single quotes still resolves and serializes as a badge', () => {
  const { layout } = resolve("'@cart.ts'", [fileItem('src/cart.ts')], [fileEntry('@cart.ts', 'src/cart.ts')]);
  assert.equal(layout.badges.length, 1);
  assert.equal(layout.badges[0]!.start, 1);
  assert.equal(layout.badges[0]!.end, 9);
  assert.equal(layout.chipItems.length, 0);
});

test('a per-message memo keeps every mounted message parsed once beyond the old 256-entry cache', () => {
  const messages = Array.from({ length: 300 }, (_, index) => serializeMentionedContext(
    { trayItems: [fileItem(`src/file-${index}.ts`)], active: [fileEntry(`@file-${index}.ts`, `src/file-${index}.ts`)] },
    `Please check @file-${index}.ts now`,
  ));
  let parses = 0;
  const parse = (text: string) => { parses += 1; return parseMessageMentions(text); };
  const memos = messages.map(() => createMessageMentionsMemo(parse));
  // First render: exactly one parse per mounted message.
  messages.forEach((text, index) => assert.ok(memos[index]!(text)));
  assert.equal(parses, messages.length);
  // Re-render the whole transcript with unchanged text: nothing is reparsed.
  messages.forEach((text, index) => memos[index]!(text));
  assert.equal(parses, messages.length, 'unchanged messages are not reparsed');
  // Only a message whose text changed pays for a parse.
  memos[5]!('plain text with no envelope');
  assert.equal(parses, messages.length + 1);
  assert.equal(parseMessageMentions('plain text with no envelope'), undefined);
});
