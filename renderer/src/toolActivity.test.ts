import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatItem, ChatPart } from '@threadterm/protocol';
import { activeToolEntries, describeTool, groupToolActivity, toolEntriesForItems, toolStatus, withoutToolParts } from './toolActivity';

const en = (english: string, _zh: string) => english;
const zh = (_english: string, chinese: string) => chinese;
const row = (id: string, parts: ChatPart[], turnId = 'turn'): ChatItem => ({ id, role: 'assistant', parts, turnId, createdAt: 'now' });
const tool = (id: string, name: string, status = 'completed', data: unknown = {}): ChatPart => ({ type: 'tool', toolId: id, toolName: name, status, data });

test('alternating commands and browser MCP keep one ordered group across AI text and approval', () => {
  const parts = [tool('c1', 'commandExecution'), tool('b1', 'mcpToolCall', 'completed', { server: 'playwright', tool: 'browser_navigate' }),
    tool('c2', 'Bash'), tool('b2', 'mcp__playwright__browser_snapshot')];
  const items = [row('one', [parts[0]!]), row('ai', [{ type: 'text', text: 'Inspecting the page.' }]), row('two', [parts[1]!]),
    row('approval', [{ type: 'approval', approvalId: 'approval', status: 'pending' }]), row('three', [parts[2]!, parts[3]!])];
  const before = JSON.stringify(items), result = groupToolActivity(items), groups = result.filter(entry => entry.type === 'tools');
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.tools.map(entry => entry.part.toolId), ['c1', 'b1', 'c2', 'b2']);
  assert.deepEqual(result.filter(entry => entry.type === 'item').map(entry => entry.item.id), ['ai', 'approval']);
  assert.deepEqual(groups[0]!.tools.map(entry => describeTool(entry.part, en).kind), ['command', 'browser', 'command', 'browser']);
  assert.equal(JSON.stringify(items), before);
});

test('all tools including failures and cancellations are retained; native IDs survive sliced text', () => {
  const image = 'data:image/png;base64,AA==';
  const part = { ...tool('file', 'Read', 'failed', { images: [image] }), fileReferences: [{ path: 'a.ts', line: 2 }] };
  const items = [row('mixed', [{ type: 'thinking', text: 'Thinking.', status: 'streaming' }, part,
    { type: 'text', text: 'After the read.' }, tool('search', 'Grep', 'cancelled'), { type: 'error', text: 'Visible error.' }])];
  const entries = toolEntriesForItems(items), result = groupToolActivity(items), plain = withoutToolParts(items);
  assert.deepEqual(entries.map(entry => entry.part.toolId), ['file', 'search']);
  assert.equal(entries[0]!.part, part);
  assert.equal(plain[0]!.id, 'mixed');
  assert.deepEqual(plain[0]!.parts.map(part => part.type), ['thinking', 'text', 'error']);
  assert.ok(result.filter(entry => entry.type === 'item').every(entry => entry.item.id === 'mixed'));
  assert.equal(new Set(result.map(entry => entry.id)).size, result.length);
});

test('missing tool IDs and repeated names never cause call deduplication', () => {
  const same = { type: 'tool' as const, toolName: 'Browser', status: 'running' };
  const items = [row('one', [same, same]), row('two', [same]), row('three', [tool('duplicate', 'Browser'), tool('duplicate', 'Browser')])];
  const entries = toolEntriesForItems(items);
  assert.equal(entries.length, 5);
  assert.equal(new Set(entries.map(entry => entry.id)).size, 5);
  const groups = groupToolActivity(items).filter(entry => entry.type === 'tools');
  assert.equal(groups[0]!.tools.length, 5);
  assert.equal(new Set(groups[0]!.tools.map(entry => entry.id)).size, 5);
});

test('user/system/status/turn boundaries remain separate, including absent turn identity', () => {
  for (const boundary of [row('u', []), row('s', [{ type: 'status' }]), row('system', [])]) {
    if (boundary.id === 'u') boundary.role = 'user';
    if (boundary.id === 'system') boundary.role = 'system';
    const groups = groupToolActivity([row('one', [tool('one', 'Bash')]), boundary, row('two', [tool('two', 'Browser')])]).filter(entry => entry.type === 'tools');
    assert.equal(groups.length, 2);
    assert.notEqual(groups[0]!.id, groups[1]!.id);
  }
  const different = [row('one', [tool('one', 'Bash')], 'a'), row('two', [tool('two', 'Browser')], 'b')];
  assert.equal(groupToolActivity(different).filter(entry => entry.type === 'tools').length, 2);
  assert.equal(groupToolActivity(different.map(item => ({ ...item, turnId: undefined }))).filter(entry => entry.type === 'tools').length, 2);
});

test('drawer and native tool keys survive appends, output updates and completion', () => {
  const before = groupToolActivity([row('one', [tool('one', 'Bash', 'running')])]);
  const after = groupToolActivity([row('one', [tool('one', 'Bash', 'complete')]), row('two', [tool('two', 'Browser', 'in_progress')])]);
  assert.equal(before[0]!.id, after[0]!.id);
  assert.equal(before[0]!.type, 'tools');
  if (before[0]!.type === 'tools' && after[0]!.type === 'tools') assert.equal(before[0]!.tools[0]!.id, after[0]!.tools[0]!.id);
});

test('provider raw and normalized status spellings retain activity, failure and interruption', () => {
  for (const status of ['running', 'pending', 'in_progress', 'inProgress', 'streaming', 'executing']) assert.equal(toolStatus(tool('x', 'tool', status)), 'running', status);
  for (const status of ['complete', 'completed', 'success', 'succeeded']) assert.equal(toolStatus(tool('x', 'tool', status)), 'complete', status);
  for (const status of ['failed', 'error', 'declined', 'rejected']) assert.equal(toolStatus(tool('x', 'tool', status)), 'failed', status);
  for (const status of ['cancelled', 'canceled', 'interrupted', 'aborted']) assert.equal(toolStatus(tool('x', 'tool', status, { exitCode: 130 })), 'cancelled', status);
  assert.equal(toolStatus(tool('x', 'commandExecution', 'completed', { exitCode: 1 })), 'failed');
  assert.equal(toolStatus({ type: 'tool', data: { state: { status: 'error' } } }), 'failed');
  assert.equal(toolStatus({ type: 'tool' }), 'unknown');
});

test('latest active selection excludes settled calls and stale inactive history', () => {
  const entries = toolEntriesForItems([row('one', [tool('c1', 'Bash', 'running'), tool('b1', 'Browser', 'in_progress'), tool('c2', 'Bash', 'completed')])]);
  assert.deepEqual(activeToolEntries(entries, true).map(entry => entry.part.toolId), ['c1', 'b1']);
  assert.equal(activeToolEntries(entries, true).at(-1)!.part.toolId, 'b1');
  assert.deepEqual(activeToolEntries(entries, false), []);
});

test('all provider input shapes describe commands and browser operations without category reordering', () => {
  for (const part of [tool('x', 'commandExecution', 'running', { commandActions: [{ command: 'npm run lint' }] }),
    tool('x', 'Bash', 'running', { input: { command: 'npm run lint' } }),
    tool('x', 'Terminal', 'running', { kind: 'execute', rawInput: { command: 'npm run lint' } }),
    tool('x', 'Terminal', 'running', { kind: 'execute', rawInput: 'npm run lint' }),
    tool('x', 'bash', 'running', { state: { input: { command: 'npm run lint' } } })]) {
    assert.deepEqual(describeTool(part, en), { kind: 'command', name: 'Command', action: 'Running command', detail: 'npm run lint' });
  }
  for (const part of [tool('x', 'mcpToolCall', 'inProgress', { server: 'playwright', tool: 'browser_navigate', arguments: { url: 'http://localhost:8080/page?token=hidden#fragment' } }),
    tool('x', 'mcp__playwright__browser_navigate', 'running', { input: { url: 'http://localhost:8080/page' } }),
    tool('x', 'browser_navigate', 'running', { rawInput: JSON.stringify({ url: 'http://localhost:8080/page' }) })]) {
    assert.deepEqual(describeTool(part, en), { kind: 'browser', name: 'Open page', action: 'Browsing', detail: 'localhost:8080/page' });
  }
  assert.equal(describeTool(tool('x', 'mcp__browser__browser_click'), zh).name, '点击元素');
  assert.equal(describeTool(tool('x', 'file_search'), en).kind, 'search');
  assert.equal(describeTool(tool('x', 'mcp__threadterm__delegate_wait'), en).kind, 'delegation');
  assert.equal(describeTool(tool('x', 'mcpToolCall', 'complete', { server: 'custom', tool: 'get_status' }), en).kind, 'mcp');
  assert.equal(describeTool(tool('x', 'mcp__custom__get_execution_history'), en).kind, 'mcp');
  assert.deepEqual(describeTool(tool('x', 'fileChange', 'running', { changes: [{ path: 'a.ts' }, { path: 'b.ts' }] }), en), { kind: 'file', name: 'Files', action: 'Applying changes', detail: 'a.ts (+1)' });
});

test('a retracted parent tool snapshot no longer contributes to the drawer', () => {
  const before = row('spawn', [tool('spawn', 'Agent')]);
  const retracted = { ...before, parts: [] };
  assert.equal(toolEntriesForItems([before]).length, 1);
  assert.equal(toolEntriesForItems([retracted]).length, 0);
  assert.equal(groupToolActivity([retracted]).filter(entry => entry.type === 'tools').length, 0);
});
