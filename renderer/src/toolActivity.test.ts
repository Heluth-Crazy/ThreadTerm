import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import type { ChatItem, ChatPart } from '@threadterm/protocol';
import { groupCodexTranscript } from './codexTranscript';
import { activeToolEntries, completedTurnPresentation, describeTool, groupToolActivity, hiddenQuestionTool, orderCompletedTurnItems, toolActivityPreview, toolActivityWaitingLabel, toolEntriesForItems, toolOutputPreview, toolStatus, withoutToolParts } from './toolActivity';

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

test('completed turns retain approval, intervening text, and final answer order', () => {
  const approval = row('approval', [{ type: 'approval', approvalId: 'approval', status: 'answered' }]);
  const text = row('text', [{ type: 'text', text: 'I will apply that choice.' }]);
  const answer = { ...row('answer', [{ type: 'text', text: 'The final answer.' }]), elapsedMs: 1_000 };
  const [turn] = groupCodexTranscript([approval, text, answer], false);
  assert.deepEqual(turn!.response.map(item => item.id), ['approval', 'text', 'answer']);
  assert.deepEqual(orderCompletedTurnItems(turn!.response).map(item => item.id), ['approval', 'text', 'answer']);
});

test('completed turns move a late-updated approval before the final answer', () => {
  const text = row('text', [{ type: 'text', text: 'I will apply that choice.' }]);
  const answer = { ...row('answer', [{ type: 'text', text: 'The final answer.' }, { type: 'approval', approvalId: 'approval', status: 'answered' }]), elapsedMs: 1_000 };
  const [turn] = groupCodexTranscript([text, answer], false);
  const before = JSON.stringify(turn!.response), ordered = orderCompletedTurnItems(turn!.response);
  assert.deepEqual(ordered.flatMap(item => item.parts.map(part => part.type)), ['text', 'approval', 'text']);
  assert.deepEqual(ordered.map(item => item.id), ['text', 'answer']);
  assert.equal(new Set(ordered.map(item => item.id)).size, ordered.length);
  assert.equal(JSON.stringify(turn!.response), before);
  assert.deepEqual(groupToolActivity(turn!.response).filter(entry => entry.type === 'item').flatMap(entry => entry.item.parts.map(part => part.type)), ['text', 'text', 'approval']);
});

test('completed turns move a later question row before the final answer without duplicating native rows', () => {
  const text = row('text', [{ type: 'text', text: 'I will apply that choice.' }]);
  const answer = row('answer', [{ type: 'text', text: 'The final answer.' }]);
  const question = row('question', [{ type: 'approval', approvalId: 'question', status: 'answered', data: { interaction: 'question' } }]);
  const source = [text, answer, question];
  const before = JSON.stringify(source), ordered = orderCompletedTurnItems(source);
  assert.deepEqual(ordered.map(item => item.id), ['text', 'question', 'answer']);
  assert.equal(new Set(ordered.map(item => item.id)).size, ordered.length);
  assert.equal(JSON.stringify(source), before);
});

test('completed background turns keep the live text-card-text order without mutating items', () => {
  const items = [row('intro', [{ type: 'text', text: 'Starting a background task.' }]),
    row('card', [{ type: 'subagent', status: 'completed' }]),
    { ...row('answer', [{ type: 'text', text: 'It will report later.' }]), elapsedMs: 1_000 }];
  const before = JSON.stringify(items);
  const [turn] = groupCodexTranscript(items, false);
  const presentation = completedTurnPresentation(turn!.activity, turn!.response);
  const live = groupToolActivity(items).filter(entry => entry.type === 'item').map(entry => entry.item.id);
  assert.deepEqual(presentation.response.map(item => item.id), live);
  assert.deepEqual(presentation.subagents, []);
  assert.deepEqual(presentation.activity, []);
  assert.equal(JSON.stringify(items), before);
});

test('activity cards stay before the response; work and the single drawer retain all ordinary tools', () => {
  const items = [row('work', [{ type: 'thinking', text: 'Planning.' }, tool('read', 'Read')]),
    row('early', [{ type: 'subagent', status: 'completed' }]),
    row('intro', [{ type: 'text', text: 'Starting another background task.' }]),
    row('mixed', [{ type: 'text', text: 'Before.' }, { type: 'subagent', status: 'completed' }, tool('write', 'Write'), { type: 'text', text: 'After.' }]),
    { ...row('answer', [{ type: 'text', text: 'Finished.' }]), elapsedMs: 1_000 }];
  const before = JSON.stringify(items);
  const [turn] = groupCodexTranscript(items, false);
  const presentation = completedTurnPresentation(turn!.activity, turn!.response);
  assert.deepEqual(presentation.subagents.map(item => item.id), ['early']);
  assert.deepEqual(presentation.activity.flatMap(item => item.parts.map(part => part.type)), ['thinking']);
  assert.deepEqual(presentation.response.map(item => item.id), ['intro', 'mixed', 'answer']);
  assert.deepEqual(presentation.response[1]!.parts.map(part => part.type), ['text', 'subagent', 'text']);
  assert.deepEqual(toolEntriesForItems(turn!.items).map(entry => entry.part.toolId), ['read', 'write']);
  assert.equal(JSON.stringify(items), before);
});

test('completed card ordering keeps late questions before the final answer', () => {
  const source = [row('intro', [{ type: 'text', text: 'Starting.' }]), row('card', [{ type: 'subagent' }]),
    row('answer', [{ type: 'text', text: 'Final answer.' }]),
    { ...row('question', [{ type: 'approval', approvalId: 'question', status: 'answered', data: { interaction: 'question' } }]), elapsedMs: 1_000 }];
  const [turn] = groupCodexTranscript(source, false);
  const presentation = completedTurnPresentation(turn!.activity, turn!.response);
  assert.deepEqual(presentation.response.map(item => item.id), ['intro', 'card', 'question', 'answer']);
  assert.equal(new Set(presentation.response.map(item => item.id)).size, 4);
});

test('Codex commentary cards stay in activity; cards after the final text stay in the response', () => {
  const source = [row('commentary', [{ type: 'text', text: 'Working.' }]), row('early', [{ type: 'subagent' }]),
    row('answer', [{ type: 'text', text: 'Final answer.' }]), { ...row('late', [{ type: 'subagent' }]), elapsedMs: 1_000 }];
  const [turn] = groupCodexTranscript(source);
  const presentation = completedTurnPresentation(turn!.activity, turn!.response);
  assert.deepEqual(presentation.activity.map(item => item.id), ['commentary']);
  assert.deepEqual(presentation.subagents.map(item => item.id), ['early']);
  assert.deepEqual(presentation.response.map(item => item.id), ['answer', 'late']);
  const [cardsOnly] = groupCodexTranscript([{ ...row('only', [{ type: 'subagent' }]), elapsedMs: 1_000 }]);
  assert.deepEqual(completedTurnPresentation(cardsOnly!.activity, cardsOnly!.response).subagents.map(item => item.id), ['only']);
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

test('Pi args describe live and settled tool calls without treating results as inputs', () => {
  const running = tool('pi', 'bash', 'running', { args: { command: 'Get-ChildItem' } });
  const complete = tool('pi', 'bash', 'complete', { args: { command: 'Get-ChildItem' }, result: { content: [{ type: 'text', text: 'one\ntwo' }] } });
  assert.deepEqual(describeTool(running, en), { kind: 'command', name: 'Command', action: 'Running command', detail: 'Get-ChildItem' });
  assert.deepEqual(describeTool(complete, en), { kind: 'command', name: 'Command', action: 'Running command', detail: 'Get-ChildItem' });
  assert.equal(toolOutputPreview(complete), 'two');
});

test('tool output previews use only provider result fields and normalize the last useful line', () => {
  const cases: [string, ChatPart, string][] = [
    ['Pi update', tool('pi-update', 'bash', 'running', { partialResult: { content: [{ type: 'text', text: 'first\npartial result' }] } }), 'partial result'],
    ['Pi end', tool('pi-end', 'bash', 'complete', { result: { content: [{ type: 'text', text: 'done' }] } }), 'done'],
    ['Codex', tool('codex', 'commandExecution', 'complete', { aggregatedOutput: '\u001b[32mfirst\nlast\u001b[0m' }), 'last'],
    ['terminal progress', tool('terminal', 'commandExecution', 'running', { aggregatedOutput: '\u001b]0;title\u0007halfway\rdone' }), 'done'],
    ['Claude', tool('claude', 'tool_result', 'complete', { content: [{ type: 'text', text: 'Claude result' }] }), 'Claude result'],
    ['ACP raw', tool('acp-raw', 'Read', 'complete', { rawOutput: { content: [{ type: 'text', text: 'ACP raw result' }] } }), 'ACP raw result'],
    ['ACP state', tool('acp-state', 'Read', 'complete', { state: { output: 'state result' } }), 'state result'],
  ];
  for (const [provider, part, expected] of cases) assert.equal(toolOutputPreview(part), expected, provider);
  assert.equal(toolOutputPreview(tool('input-only', 'bash', 'running', { args: { command: 'never preview this' }, input: { output: 'also input' } })), undefined);
  assert.equal(toolOutputPreview(tool('malformed', 'bash', 'complete', { result: { content: [{ type: 'image' }, null, { text: 42 }] } })), undefined);
  // Live Kimi ExitPlanMode: the empty argument object arrives as content.
  assert.equal(toolOutputPreview(tool('kimi-args', 'ExitPlanMode', 'running', { content: [{ type: 'content', content: { type: 'text', text: '{}' } }] })), undefined);
  // A pretty-printed JSON result previews its last real line, not the closing brace.
  assert.equal(toolOutputPreview(tool('json', 'delegate_result', 'complete', { result: { content: [{ type: 'text', text: '{\n  "finalAnswer": "DONE-A"\n}' }] } })), '"finalAnswer": "DONE-A"');
  const long = 'x'.repeat(250);
  assert.equal(toolOutputPreview(tool('long', 'bash', 'complete', { output: long })), `${'x'.repeat(239)}…`);
});

test('tool activity previews prefer the latest running result then fall back to the newest available output', () => {
  const entries = toolEntriesForItems([row('tools', [
    tool('finished', 'bash', 'complete', { result: { content: [{ type: 'text', text: 'finished output' }] } }),
    tool('running', 'bash', 'running', { args: { command: 'long job' } }),
  ])]);
  assert.deepEqual(toolActivityPreview(entries, true), { entryId: entries[0]!.id, text: 'finished output' });
  const withLiveOutput = [...entries.slice(0, 1), { ...entries[1]!, part: tool('running', 'bash', 'running', { partialResult: { content: [{ type: 'text', text: 'live output' }] } }) }];
  assert.deepEqual(toolActivityPreview(withLiveOutput, true), { entryId: withLiveOutput[1]!.id, text: 'live output' });
  assert.deepEqual(toolActivityPreview(entries, false), { entryId: entries[0]!.id, text: 'finished output' });
});

test('a retracted parent tool snapshot no longer contributes to the drawer', () => {
  const before = row('spawn', [tool('spawn', 'Agent')]);
  const retracted = { ...before, parts: [] };
  assert.equal(toolEntriesForItems([before]).length, 1);
  assert.equal(toolEntriesForItems([retracted]).length, 0);
  assert.equal(groupToolActivity([retracted]).filter(entry => entry.type === 'tools').length, 0);
});

test('native question tool rows are hidden in favor of their question cards', () => {
  const questions = [
    tool('grok-name', 'ask_user_question'),
    tool('grok-label', 'Ask User'),
    tool('grok-meta', 'other', 'completed', { _meta: { 'x.ai/tool': { kind: 'ask_user' } } }),
    tool('grok-meta-label', 'other', 'completed', { _meta: { 'x.ai/tool': { label: 'Ask User' } } }),
    tool('kimi', 'AskUserQuestion'),
    tool('kimi-localized', 'other', 'completed', { title: 'Asking user questions' }),
    tool('opencode', 'question'),
  ];
  assert.ok(questions.every(hiddenQuestionTool));
  const visible = tool('visible', 'Read');
  const items = [row('questions', [...questions, visible])];
  assert.deepEqual(toolEntriesForItems(items).map(entry => entry.part.toolId), ['visible']);
  assert.deepEqual(groupToolActivity(items).filter(entry => entry.type === 'tools').flatMap(entry => entry.tools.map(tool => tool.part.toolId)), ['visible']);
});

test('Grok fixture preserved completed question part remains named and hidden', () => {
  const frames = readFileSync(resolve(process.cwd(), 'runtime/tests/fixtures/grok-question-frames.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(line => JSON.parse(line).frame.params.update).filter(Boolean);
  const initial = frames.find(update => update.sessionUpdate === 'tool_call')!;
  const complete = frames.find(update => update.sessionUpdate === 'tool_call_update' && update.status === 'completed')!;
  const xaiTool = initial._meta['x.ai/tool'];
  assert.equal(complete.title, undefined, 'recorded completion deliberately omits the title');
  const preserved: ChatPart = {
    type: 'tool', toolId: complete.toolCallId, toolName: xaiTool.label, status: complete.status,
    data: { ...complete, _meta: { 'x.ai/tool': xaiTool } },
  };
  assert.equal(preserved.toolName, 'Ask User');
  assert.ok(hiddenQuestionTool(preserved));
  assert.deepEqual(toolEntriesForItems([row('grok-question', [preserved])]), []);
});

test('Kimi recorded completed question title is hidden by the completed-turn drawer fold', () => {
  const toolRow = row('kimi-question-tool', [tool('kimi-question', 'Asking user questions', 'complete', {
    title: 'Asking user questions', status: 'completed', toolCallId: 'kimi-question',
  })]);
  const question = row('kimi-question-card', [{ type: 'approval', approvalId: 'question', status: 'answered', data: { interaction: 'question', title: 'AskUserQuestion' } }]);
  const answer = { ...row('kimi-answer', [{ type: 'text', text: 'Sapphire' }]), elapsedMs: 33_000 };
  const [turn] = groupCodexTranscript([toolRow, question, answer], false);
  assert.equal(turn!.elapsedMs, 33_000);
  assert.equal((turn!.items.find(item => item.id === 'kimi-question-card')!.parts[0]!.data as { title: string }).title, 'AskUserQuestion');
  assert.deepEqual(toolEntriesForItems(turn!.items), [], 'completed drawers inspect group.items through hiddenQuestionTool');
  assert.deepEqual(orderCompletedTurnItems(withoutToolParts(turn!.response)).map(item => item.id), ['kimi-question-card', 'kimi-answer']);
});

test('pending question drawers name the answer action in both locales', () => {
  assert.equal(toolActivityWaitingLabel(false, true, en), 'Waiting for approval');
  assert.equal(toolActivityWaitingLabel(true, true, en), 'Waiting for your answer');
  assert.equal(toolActivityWaitingLabel(true, true, zh), '等待你的回答');
});
