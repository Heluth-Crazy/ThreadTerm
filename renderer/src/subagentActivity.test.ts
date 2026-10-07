import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatItem, ChatPart, SubagentInfo } from '@threadterm/protocol';
import { elapsedMs, isSubagentPart, mergeTranscript, stripInlineMarkdown, subagentInfo, subagentItemsOf, subagentStatus, subagentTitle, subagentToolCount, withoutPromptEcho } from './subagentActivity';
import { groupToolActivity, toolEntriesForItems } from './toolActivity';

const en = (english: string, _chinese: string) => english;
const zh = (_english: string, chinese: string) => chinese;
const info = (extra: Partial<SubagentInfo> = {}): SubagentInfo => ({ key: 'child', provider: 'codex', status: 'running', transcript: 'live', ...extra });
const card = (extra: Partial<SubagentInfo> = {}): ChatPart => ({ type: 'subagent', data: info(extra) });
const row = (id: string, parts: ChatPart[] = []): ChatItem => ({ id, role: 'assistant', turnId: 'parent', createdAt: 'now', parts });

test('isSubagentPart identifies the protocol discriminator, including legacy static cards', () => {
  assert.equal(isSubagentPart(card()), true);
  assert.equal(isSubagentPart({ type: 'subagent' }), true);
  for (const type of ['text', 'thinking', 'tool', 'approval', 'usage', 'error', 'status'] as const) assert.equal(isSubagentPart({ type }), false);
});

test('subagentInfo preserves the implemented protocol metadata without mutating data', () => {
  const part = card({ background: true, depth: 2, prompt: 'Inspect', usage: { totalTokens: 34000 }, native: { kind: 'codex-thread', id: 'native' }, rev: 5, truncated: true });
  const before = JSON.stringify(part);
  assert.deepEqual(subagentInfo(part), part.data);
  assert.notEqual(subagentInfo(part), part.data);
  assert.equal(JSON.stringify(part), before);
});

test('subagentInfo handles missing history fields and rejects non-card or unidentifiable parts', () => {
  assert.equal(subagentInfo({ type: 'tool', toolId: 'child' }), undefined);
  assert.equal(subagentInfo({ type: 'subagent', data: null }), undefined);
  assert.deepEqual(subagentInfo({ type: 'subagent', toolId: 'old', status: 'completed', data: { name: 'Kant' } }),
    { key: 'old', provider: '', name: 'Kant', status: 'completed', transcript: 'none' });
  assert.equal(subagentInfo({ type: 'subagent', toolId: 'old', data: [] })?.status, 'unknown');
  assert.equal(subagentInfo(card({ transcript: 'invalid' as SubagentInfo['transcript'] }))?.transcript, 'none');
  assert.equal(subagentInfo(card({ transcript: 'native' }))?.transcript, 'native');
});

test('subagentTitle uses type and description, then nickname and localized fallback', () => {
  assert.equal(subagentTitle(info({ agentType: 'explore', description: 'Inspect approvals', name: 'Kant' }), en), 'explore · Inspect approvals');
  assert.equal(subagentTitle(info({ agentType: 'coder' }), en), 'coder');
  assert.equal(subagentTitle(info({ description: 'Inspect' }), en), 'Inspect');
  assert.equal(subagentTitle(info({ provider: 'claude', agentType: ' ', description: '', name: '/root/Kant' }), en), '/root/Kant');
  assert.equal(subagentTitle(info({ agentType: 'explore', description: '', name: '/root/count_files' }), en), 'count_files');
  assert.equal(subagentTitle(info(), en), 'Subagent');
  assert.equal(subagentTitle(info(), zh), '子代理');
});

test('stripInlineMarkdown makes a compact summary preview readable', () => {
  assert.equal(stripInlineMarkdown('Found **3 files** in [`src`](https://example.test).'), 'Found 3 files in src.');
  assert.equal(stripInlineMarkdown('## `Result`\n~~none~~'), 'Result\nnone');
  assert.equal(stripInlineMarkdown('Read `foo_bar_baz` and ***nested emphasis***.'), 'Read foo_bar_baz and nested emphasis.');
});

test('subagentStatus preserves every protocol state and treats unrecognized values as unknown', () => {
  for (const status of ['running', 'completed', 'failed', 'cancelled', 'unknown'] as const) assert.equal(subagentStatus(info({ status })), status);
  for (const status of ['pending', 'success', '', undefined]) assert.equal(subagentStatus({ status: status as SubagentInfo['status'] }), 'unknown');
});

test('elapsedMs uses the current clock only while running and freezes at the terminal timestamp', () => {
  const start = '2026-10-07T10:00:00Z', end = '2026-10-07T10:02:14Z';
  assert.equal(elapsedMs(info({ startedAt: start }), Date.parse(end)), 134000);
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    assert.equal(elapsedMs(info({ status, startedAt: start, endedAt: end }), Date.parse(end) + 99000), 134000);
  }
  assert.equal(elapsedMs(info({ startedAt: end }), Date.parse(start)), 0);
});

test('elapsedMs does not fabricate missing duration and tolerates malformed timestamps', () => {
  assert.equal(elapsedMs(info()), undefined);
  assert.equal(elapsedMs(info({ status: 'completed', startedAt: '2026-10-07T10:00:00Z' })), undefined);
  assert.equal(elapsedMs(info({ startedAt: 'bad', usage: { durationMs: 5000 } })), 5000);
  assert.equal(elapsedMs(info({ usage: { durationMs: -10 } })), 0);
  assert.equal(elapsedMs(info({ usage: { durationMs: Infinity } })), undefined);
});

test('mergeTranscript replaces updated snapshots by id while preserving insertion order', () => {
  const first = row('first', [{ type: 'tool', toolId: 'tool', status: 'running' }]);
  const second = row('second', [{ type: 'text', text: 'Before' }]);
  const updated = row('first', [{ type: 'tool', toolId: 'tool', status: 'completed', text: 'Output' }]);
  const third = row('third');
  const prev = [first, second], incoming = [updated, third];
  const before = JSON.stringify([prev, incoming]);
  assert.deepEqual(mergeTranscript(prev, incoming), [updated, second, third]);
  assert.equal(JSON.stringify([prev, incoming]), before);
  assert.deepEqual(mergeTranscript([], [first, updated]), [updated]);
  assert.deepEqual(mergeTranscript(prev, []), prev);
});

test('withoutPromptEcho removes only a leading user row that repeats the task prompt', () => {
  const echoed = row('prompt', [{ type: 'text', text: 'Inspect the folder' }]);
  const later = { ...row('later', [{ type: 'text', text: 'Inspect the folder' }]), role: 'user' as const };
  const answer = row('answer', [{ type: 'text', text: 'Done' }]);
  const leadingUser = { ...echoed, role: 'user' as const };
  const source = [leadingUser, answer, later];
  assert.deepEqual(withoutPromptEcho(source, 'Inspect the folder').map(item => item.id), ['answer', 'later']);
  assert.deepEqual(withoutPromptEcho(source, 'Different').map(item => item.id), ['prompt', 'answer', 'later']);
  assert.deepEqual(withoutPromptEcho([answer, later], 'Inspect the folder').map(item => item.id), ['answer', 'later']);
  assert.deepEqual(source.map(item => item.id), ['prompt', 'answer', 'later']);
});

test('withoutPromptEcho retains prompt rows with unique attachments or non-text content', () => {
  const prompt = 'Inspect the folder';
  const attachment = { ...row('attachment', [{ type: 'text', text: prompt, fileReferences: [{ path: 'notes.md' }] }]), role: 'user' as const };
  const image = { ...row('image', [{ type: 'text', text: prompt, data: { images: ['data:image/png;base64,AA=='] } }]), role: 'user' as const };
  const mixed = { ...row('mixed', [{ type: 'text', text: prompt }, { type: 'tool', toolName: 'Read' }]), role: 'user' as const };
  for (const item of [attachment, image, mixed]) assert.deepEqual(withoutPromptEcho([item], prompt).map(row => row.id), [item.id]);
});

test('subagentItemsOf selects only card parts in canonical creation order without losing mixed text', () => {
  const parts = [card({ key: 'one' }), { type: 'text' as const, text: 'Answer' }, card({ key: 'two' })];
  const items = [row('plain', [{ type: 'text', text: 'Before' }]), row('mixed', parts), row('later', [card({ key: 'three' })])];
  const before = JSON.stringify(items), result = subagentItemsOf(items);
  assert.deepEqual(result.map(item => item.id), ['mixed', 'later']);
  assert.deepEqual(result[0]?.parts, [parts[0], parts[2]]);
  assert.equal(JSON.stringify(items), before);
  assert.deepEqual(subagentItemsOf([]), []);
});

test('legacy native spawn rows never reach live or completed tool drawers', () => {
  const tool = (toolName: string): ChatPart => ({ type: 'tool', toolName, toolId: toolName });
  const items = [row('old', [tool('subAgentActivity'), tool('collabAgentToolCall')]), row('mixed', [tool('Read'), card(), tool('collabAgentToolCall')])];
  assert.deepEqual(toolEntriesForItems(items).map(entry => entry.part.toolName), ['Read']);
  const grouped = groupToolActivity(items);
  assert.deepEqual(grouped.filter(entry => entry.type === 'tools').flatMap(entry => entry.tools.map(tool => tool.part.toolName)), ['Read']);
  assert.equal(grouped.filter(entry => entry.type === 'item').length, 1);
  assert.equal(grouped.at(-1)?.type, 'item');
});
test('subagentToolCount localizes singular, plural and zero tool counts', () => {
  assert.equal(subagentToolCount(1, en), '1 tool');
  assert.equal(subagentToolCount(2, en), '2 tools');
  assert.equal(subagentToolCount(0, en), '0 tools');
  assert.equal(subagentToolCount(1, zh), '1 个工具');
  assert.equal(subagentToolCount(12, zh), '12 个工具');
});
