import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatItem, ChatPart } from '@threadterm/protocol';
import { isReplyTextPart, replyMarkdown } from './replyMarkdown';

const item = (role: ChatItem['role'], parts: ChatPart[]): ChatItem => ({ id: 'item', role, parts, createdAt: 'now' });
const text = (value: string, phase?: ChatPart['phase']): ChatPart => ({ type: 'text', text: value, ...(phase ? { phase } : {}) });

test('replyMarkdown picks final-answer text parts and drops commentary', () => {
  const reply = item('assistant', [
    text('Working on it.', 'commentary'),
    text('## Answer\n\nThe result.'),
    text('One more paragraph.', 'final_answer'),
  ]);
  assert.equal(replyMarkdown(reply), '## Answer\n\nThe result.\n\nOne more paragraph.');
});

test('replyMarkdown joins several final-answer parts with blank lines and trims each', () => {
  const reply = item('assistant', [text('  first  '), text('\nsecond\n'), text('   ')]);
  assert.equal(replyMarkdown(reply), 'first\n\nsecond');
});

test('replyMarkdown keeps unphased text because not every provider marks commentary', () => {
  const reply = item('assistant', [text('Unphased answer')]);
  assert.equal(replyMarkdown(reply), 'Unphased answer');
});

test('replyMarkdown ignores tool, thinking, sub-agent, usage-card and empty text parts', () => {
  const reply = item('assistant', [
    { type: 'thinking', text: 'reasoning' },
    { type: 'tool', toolName: 'Read', toolId: 'tool-1' },
    { type: 'subagent', data: { key: 'child' } },
    { type: 'text', text: 'plan', data: { kind: 'plan' } },
    { type: 'text', text: '   ' },
    text('Real answer'),
  ]);
  assert.equal(replyMarkdown(reply), 'Real answer');
  assert.equal(isReplyTextPart({ type: 'text', text: 'plan', data: { kind: 'plan' } }), false);
  assert.equal(isReplyTextPart({ type: 'text', text: 'ok' }), true);
});

test('replyMarkdown is empty for user and system rows', () => {
  assert.equal(replyMarkdown(item('user', [text('Question')])), '');
  assert.equal(replyMarkdown(item('system', [text('System note')])), '');
  assert.equal(replyMarkdown(item('tool', [text('Tool text')])), '');
  assert.equal(replyMarkdown(item('assistant', [])), '');
});
