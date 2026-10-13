import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QuickMessage } from '@threadterm/protocol';
import { MAX_QUICK_MESSAGES, createQuickMessageId, insertQuickMessage, moveQuickMessage, parseQuickMessages, quickMessageLength, validQuickMessageId } from './quickMessages';

test('parseQuickMessages keeps only bounded, unique entries', () => {
  const messages = parseQuickMessages([
    { id: 'a', title: 'Summarize', text: 'Summarize the diff.' },
    { id: 'a', title: 'Duplicate id', text: 'Dropped.' },
    { id: '', title: 'Empty id', text: 'Dropped.' },
    { id: 'b', title: '   ', text: 'Dropped.' },
    { id: 'c', title: 'Empty text', text: '' },
    { id: 'd', title: 'Missing text' },
    { id: 'e\u0000', title: 'Bad id', text: 'Dropped.' },
    { id: 'f', title: 'x'.repeat(201), text: 'Dropped.' },
    { id: 'g', title: 'Long text', text: 'x'.repeat(4001) },
    { id: 'h', title: 'Kept', text: 'Second.' },
    'not-an-item',
  ]);
  assert.deepEqual(messages.map(message => message.id), ['a', 'h']);
  assert.deepEqual(parseQuickMessages('nope'), []);
  assert.deepEqual(parseQuickMessages(undefined), []);
});

test('parseQuickMessages caps the list at 50 entries', () => {
  const overflow = Array.from({ length: 60 }, (_, index) => ({ id: `m${index}`, title: 'T', text: 'body' }));
  assert.equal(parseQuickMessages(overflow).length, MAX_QUICK_MESSAGES);
});

test('quickMessageLength counts code points and id validation matches the runtime', () => {
  assert.equal(quickMessageLength('a\u{1F600}'), 2);
  assert.equal(validQuickMessageId('ok-1'), true);
  assert.equal(validQuickMessageId(''), false);
  assert.equal(validQuickMessageId('x'.repeat(129)), false);
  assert.equal(validQuickMessageId('control\u0007'), false);
});

test('insertQuickMessage replaces the selection at the caret', () => {
  assert.deepEqual(insertQuickMessage('hello world', 6, 11, 'there'), { text: 'hello there', caret: 11 });
  assert.deepEqual(insertQuickMessage('', 0, 0, 'note'), { text: 'note', caret: 4 });
  assert.deepEqual(insertQuickMessage('abc', 99, 200, '!'), { text: 'abc!', caret: 4 });
  assert.deepEqual(insertQuickMessage('line', 2, 1, '|'), { text: 'li|ne', caret: 3 });
});

test('moveQuickMessage swaps neighbours and clamps at the ends', () => {
  const list: QuickMessage[] = [
    { id: 'a', title: 'A', text: 'a' },
    { id: 'b', title: 'B', text: 'b' },
    { id: 'c', title: 'C', text: 'c' },
  ];
  assert.deepEqual(moveQuickMessage(list, 0, 1).map(message => message.id), ['b', 'a', 'c']);
  assert.deepEqual(moveQuickMessage(list, 2, -1).map(message => message.id), ['a', 'c', 'b']);
  assert.deepEqual(moveQuickMessage(list, 0, -1).map(message => message.id), ['a', 'b', 'c']);
  assert.deepEqual(moveQuickMessage(list, 2, 1).map(message => message.id), ['a', 'b', 'c']);
  assert.notEqual(moveQuickMessage(list, 0, 1), list);
});

test('createQuickMessageId is unique and stable when crypto is unavailable', () => {
  const existing: QuickMessage[] = [{ id: 'quick-message-1', title: 'A', text: 'a' }];
  const created = createQuickMessageId(existing);
  assert.equal(typeof created, 'string');
  assert.ok(created.length > 0);
  assert.ok(!existing.some(message => message.id === created));
});
