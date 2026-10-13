import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatItem, ChatPart } from '@threadterm/protocol';
import { isReplyTextPart, replyMarkdown, replyActionMarkdown } from './replyMarkdown';

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

test('replyMarkdown joins accepted parts verbatim and rejects whitespace-only parts', () => {
  const reply = item('assistant', [text('  first  '), text('\nsecond\n'), text('   ')]);
  assert.equal(replyMarkdown(reply), '  first  \n\n\nsecond\n');
});

test('replyMarkdown preserves indented code and trailing Markdown whitespace', () => {
  const source = '    const x = 1;\n\nA hard break  \nNext line\n';
  assert.equal(replyMarkdown(item('assistant', [text(source)])), source);
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

test('segmented turns copy all answer segments on the final answer item', () => {
  const rows: ChatItem[] = [
    { ...item('assistant', [text('    Before\n')]), id: 'before', turnId: 't' },
    { ...item('assistant', [{ type: 'tool', toolId: 'read' }]), id: 'tool', turnId: 't' },
    { ...item('assistant', [text('After  \n')]), id: 'after', turnId: 't', turnStatus: 'completed' },
    { ...item('assistant', [text('Other turn')]), id: 'other', turnId: 'u', turnStatus: 'completed' },
  ];
  assert.deepEqual([...replyActionMarkdown(rows)], [['after', '    Before\n\n\nAfter  \n'], ['other', 'Other turn']]);
});

test('a text item followed by a running tool has no copy until its turn settles', () => {
  const rows: ChatItem[] = [
    { ...item('assistant', [{ type: 'text', text: 'Before', status: 'streaming' }]), id: 'before', turnId: 't' },
    { ...item('assistant', [{ type: 'tool', toolId: 'tool', status: 'running' }]), id: 'tool', turnId: 't', turnStatus: 'inProgress' },
  ];
  assert.equal(replyActionMarkdown(rows).size, 0);
  assert.deepEqual([...replyActionMarkdown([...rows, { ...item('assistant', []), id: 'done', turnId: 't', turnStatus: 'completed' }])], [['before', 'Before']]);
  for (const turnStatus of ['failed', 'interrupted'] as const) {
    assert.equal(replyActionMarkdown([...rows, { ...item('assistant', []), turnId: 't', turnStatus }]).get('before'), 'Before');
  }
  assert.equal(replyActionMarkdown([{ ...rows[0]!, elapsedMs: 4 }, rows[1]!]).size, 0, 'explicit running status wins over stale duration');
});

test('ACP replies without turn status or duration get Copy when the session becomes idle', () => {
  const rows: ChatItem[] = [
    { ...item('assistant', [text('Before')]), id: 'before', turnId: 'acp-turn' },
    { ...item('assistant', [{ type: 'tool', toolId: 'read', status: 'complete' }]), id: 'tool', turnId: 'acp-turn' },
    { ...item('assistant', [text('After')]), id: 'after', turnId: 'acp-turn' },
  ];
  assert.equal(replyActionMarkdown(rows, 'running').size, 0, 'a complete-looking item is not enough while its session still runs');
  assert.equal(replyActionMarkdown(rows, 'waiting').size, 0);
  assert.deepEqual([...replyActionMarkdown(rows, 'idle')], [['after', 'Before\n\nAfter']]);
  const streaming = [{ ...rows[0]!, parts: [{ type: 'text' as const, text: 'Before', status: 'streaming' }] }, ...rows.slice(1)];
  assert.equal(replyActionMarkdown(streaming, 'idle').size, 0, 'an earlier streaming segment still gates the whole turn');
});

test('a completed ACP reply remains copyable while a different turn runs', () => {
  const rows: ChatItem[] = [
    { ...item('assistant', [text('Previous answer')]), id: 'answer', turnId: 'previous' },
    { ...item('user', [text('Next question')]), id: 'question', turnId: 'current' },
    { ...item('assistant', [{ type: 'tool', toolId: 'tool', status: 'running' }]), id: 'tool', turnId: 'current' },
  ];
  assert.deepEqual([...replyActionMarkdown(rows, 'running')], [['answer', 'Previous answer']]);
});
