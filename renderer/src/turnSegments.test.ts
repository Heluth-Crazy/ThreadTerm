import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatItem, ChatPart } from '@threadterm/protocol';
import { foldCommentary, foldIsThinking, foldIsThinkingOnly, foldLatestStep, foldToolEntries, lastFoldIndex, turnSegments, type TurnBlock } from './turnSegments';

const text = (value: string, phase?: ChatPart['phase']): ChatPart => ({ type: 'text', text: value, status: 'complete', phase });
const think = (value: string, status = 'complete'): ChatPart => ({ type: 'thinking', text: value, status });
const tool = (id: string, status = 'completed'): ChatPart => ({ type: 'tool', toolName: 'Read', toolId: id, status, text: 'a.ts' });
const approval = (id: string, status: string): ChatPart => ({ type: 'approval', approvalId: id, status, data: { approvalId: id, requestType: 'commandExecution', choices: [] } });
const item = (id: string, parts: ChatPart[], extra: Partial<ChatItem> = {}): ChatItem =>
  ({ id, role: 'assistant', turnId: 'turn', createdAt: 'now', parts, ...extra });
const shape = (blocks: readonly TurnBlock[]) => blocks.map(block => block.kind === 'fold'
  ? { fold: block.id, steps: block.steps.map(step => step.kind === 'tool' ? `tool:${step.entry.part.toolId}` : `${step.kind}:${step.part.text ?? step.part.status}`) }
  : { item: block.item.id, parts: block.item.parts.map(part => part.text ?? part.type) });

test('a phased Codex turn keeps one fold for the whole working segment, then the answer', () => {
  const items = [
    item('a1', [think('Where is retry'), text('I will look at auth.', 'commentary')]),
    item('a2', [tool('read-1')]),
    item('a3', [text('Found it: the cap is hard-coded.', 'commentary'), tool('edit-1')]),
    item('a4', [approval('appr-1', 'resolved')]),
    item('a5', [tool('cmd-1', 'failed')]),
    item('a6', [text('Fixed. Tests pass.', 'final_answer')]),
  ];
  const live = turnSegments(items, { collapseCommentary: true });
  assert.deepEqual(shape(live), [
    { fold: 'fold:a1:0', steps: ['thinking:Where is retry', 'commentary:I will look at auth.', 'tool:read-1', 'commentary:Found it: the cap is hard-coded.', 'tool:edit-1', 'approval:resolved', 'tool:cmd-1'] },
    { item: 'a6', parts: ['Fixed. Tests pass.'] },
  ]);
  // Settling only adds the completion record: the blocks, their ids and their steps stay put.
  const settled = turnSegments([...items, item('a7', [], { elapsedMs: 8000, turnStatus: 'completed' })], { collapseCommentary: true });
  assert.deepEqual(settled, live);
});

test('a Claude turn keeps a streaming text outside until a tool arrives, then absorbs it without remounting the fold', () => {
  const before = [item('a1', [think('Look first')]), item('a2', [text('Let me read the file.')])];
  const blocks = turnSegments(before);
  assert.deepEqual(shape(blocks), [
    { fold: 'fold:a1:0', steps: ['thinking:Look first'] },
    { item: 'a2', parts: ['Let me read the file.'] },
  ]);
  const after = [...before.slice(0, 1), item('a2', [text('Let me read the file.'), tool('read-1')])];
  const grown = turnSegments(after);
  assert.deepEqual(shape(grown), [{ fold: 'fold:a1:0', steps: ['thinking:Look first', 'commentary:Let me read the file.', 'tool:read-1'] }]);
  assert.equal(grown[0]!.kind === 'fold' && grown[0]!.id, blocks[0]!.kind === 'fold' && blocks[0]!.id, 'the fold keeps its id across the jump');
});

test('an answer between two working segments starts a second fold', () => {
  const blocks = turnSegments([
    item('a1', [tool('read-1')]),
    item('a2', [text('Intermediate answer', 'final_answer')]),
    item('a3', [tool('read-2')]),
  ], { collapseCommentary: true });
  assert.deepEqual(shape(blocks), [
    { fold: 'fold:a1:0', steps: ['tool:read-1'] },
    { item: 'a2', parts: ['Intermediate answer'] },
    { fold: 'fold:a3:0', steps: ['tool:read-2'] },
  ]);
  assert.equal(lastFoldIndex(blocks), 2);
});

test('a pending approval stays outside; once resolved it becomes a step and later tools join the same fold', () => {
  const pending = [item('a1', [tool('read-1')]), item('a2', [approval('appr-1', 'pending')])];
  assert.deepEqual(shape(turnSegments(pending)), [
    { fold: 'fold:a1:0', steps: ['tool:read-1'] },
    { item: 'a2', parts: ['approval'] },
  ]);
  const decided = [item('a1', [tool('read-1')]), item('a2', [approval('appr-1', 'resolved')]), item('a3', [tool('cmd-1')])];
  const blocks = turnSegments(decided);
  assert.deepEqual(shape(blocks), [{ fold: 'fold:a1:0', steps: ['tool:read-1', 'approval:resolved', 'tool:cmd-1'] }]);
  assert.equal(blocks.length, 1, 'one fold, not a new one after the approval');
});

test('failed and interrupted calls are process parts, never dropped', () => {
  const blocks = turnSegments([item('a1', [tool('ok-1'), tool('bad-1', 'failed'), tool('stopped-1', 'cancelled')]), item('a2', [text('Done.', 'final_answer')])], { collapseCommentary: true });
  assert.deepEqual(shape(blocks), [
    { fold: 'fold:a1:0', steps: ['tool:ok-1', 'tool:bad-1', 'tool:stopped-1'] },
    { item: 'a2', parts: ['Done.'] },
  ]);
});

test('a thinking-only turn is a fold with no tools and no content blocks', () => {
  const blocks = turnSegments([item('a1', [think('one'), think('two', 'streaming')])]);
  assert.equal(blocks.length, 1);
  const fold = blocks[0]!;
  assert.equal(fold.kind, 'fold');
  if (fold.kind !== 'fold') return;
  assert.deepEqual(foldToolEntries(fold.steps), []);
  assert.equal(foldIsThinking(fold.steps), true);
  assert.equal(foldIsThinkingOnly(fold.steps), true);
  const done = turnSegments([item('a1', [think('one')])])[0]!;
  assert.equal(done.kind, 'fold', 'a completed thought still folds');
  assert.equal(done.kind === 'fold' && foldIsThinking(done.steps), false);
});

test('an old Codex record without phase keeps only the last assistant text as the answer', () => {
  const blocks = turnSegments([
    item('a1', [text('Thinking out loud')]),
    item('a2', [tool('read-1')]),
    item('a3', [text('The answer')]),
  ], { collapseCommentary: true });
  assert.deepEqual(shape(blocks), [
    { fold: 'fold:a1:0', steps: ['commentary:Thinking out loud', 'tool:read-1'] },
    { item: 'a3', parts: ['The answer'] },
  ]);
  assert.deepEqual(shape(turnSegments([item('a1', [text('Narration')]), item('a2', [text('Answer')])], { collapseCommentary: true })), [
    { fold: 'fold:a1:0', steps: ['commentary:Narration'] },
    { item: 'a2', parts: ['Answer'] },
  ]);
});

test('an ACP answer split across records is all answer', () => {
  const blocks = turnSegments([
    item('a1', [text('First part.')]),
    item('a2', [text('Second part.')]),
    item('a3', [text('Third part.')]),
  ]);
  assert.deepEqual(shape(blocks), [
    { item: 'a1', parts: ['First part.'] },
    { item: 'a2', parts: ['Second part.'] },
    { item: 'a3', parts: ['Third part.'] },
  ]);
});

test('a fold id is stable while the turn grows', () => {
  const stages: ChatItem[][] = [
    [item('a1', [think('start')])],
    [item('a1', [think('start')]), item('a2', [tool('read-1')])],
    [item('a1', [think('start')]), item('a2', [tool('read-1'), text('Note', 'commentary')])],
    [item('a1', [think('start')]), item('a2', [tool('read-1'), text('Note', 'commentary')]), item('a3', [tool('cmd-1')])],
  ];
  const ids = stages.map(stage => {
    const fold = turnSegments(stage, { collapseCommentary: true })[0]!;
    assert.equal(fold.kind, 'fold');
    return fold.kind === 'fold' ? fold.id : '';
  });
  assert.deepEqual(ids, ['fold:a1:0', 'fold:a1:0', 'fold:a1:0', 'fold:a1:0']);
});

test('cards, status, errors and hidden rows', () => {
  const subagent: ChatPart = { type: 'subagent', toolId: 'sub-1', status: 'running', data: { key: 'sub-1', status: 'running' } };
  const asked: ChatPart = { type: 'tool', toolName: 'threadterm__ask_user', toolId: 'asked', status: 'completed' };
  const blocks = turnSegments([
    item('a1', [tool('read-1'), subagent]),
    item('a2', [asked]),
    item('a3', [{ type: 'plan', text: 'the plan', data: { entries: [] } }]),
    item('a4', [{ type: 'error', text: 'boom' }]),
    item('a5', [text('Answer', 'final_answer')]),
  ]);
  assert.deepEqual(shape(blocks), [
    { fold: 'fold:a1:0', steps: ['tool:read-1'] },
    { item: 'a1', parts: ['subagent'] },
    { item: 'a4', parts: ['boom'] },
    { item: 'a5', parts: ['Answer'] },
  ]);
});

test('the collapsed second line follows the newest commentary of the fold', () => {
  const blocks = turnSegments([item('a1', [text('first', 'commentary'), tool('read-1'), text('second', 'commentary'), tool('read-2')])], { collapseCommentary: true });
  const fold = blocks[0]!;
  assert.equal(fold.kind, 'fold');
  if (fold.kind !== 'fold') return;
  assert.equal(foldCommentary(fold.steps), 'second');
  assert.equal(foldLatestStep(fold.steps)?.kind, 'tool');
  assert.deepEqual(foldToolEntries(fold.steps).map(entry => entry.part.toolId), ['read-1', 'read-2']);
});

test('user rows and usage cards are never split', () => {
  const user: ChatItem = { id: 'u1', role: 'user', turnId: 'turn', createdAt: 'now', parts: [text('Do it')] };
  const usage = item('a1', [think('a thought'), { type: 'status', data: { kind: 'usage' } }]);
  assert.deepEqual(shape(turnSegments([user, usage], { wholeItems: new Set(['a1']) })), [
    { item: 'u1', parts: ['Do it'] },
    { item: 'a1', parts: ['a thought', 'status'] },
  ]);
});

test('a settled turn seats a resolved interaction recorded after the answer before it, without changing ids', () => {
  // An adapter appended the answer to the row that carries the answered question.
  const sameRow = [item('a1', [tool('read-1')]), item('a2', [text('The final answer.'), approval('q-1', 'answered')])];
  assert.deepEqual(shape(turnSegments(sameRow)), [
    { fold: 'fold:a1:0', steps: ['tool:read-1'] },
    { item: 'a2', parts: ['The final answer.'] },
    { fold: 'fold:a2:1', steps: ['approval:answered'] },
  ], 'a live turn keeps the native order');
  assert.deepEqual(shape(turnSegments(sameRow, { settled: true })), [
    { fold: 'fold:a1:0', steps: ['tool:read-1', 'approval:answered'] },
    { item: 'a2', parts: ['The final answer.'] },
  ], 'settled: the question joins the fold before the answer');
  assert.equal(turnSegments(sameRow, { settled: true })[1]!.id, 'item:a2:0', 'the answer keeps its block id');

  // A question row recorded after a split (ACP) answer moves before the whole answer.
  const lateRow = [item('a1', [text('Part one.')]), item('a2', [text('Part two.')]), item('a3', [approval('q-2', 'answered')])];
  assert.deepEqual(shape(turnSegments(lateRow, { settled: true })), [
    { fold: 'fold:a3:0', steps: ['approval:answered'] },
    { item: 'a1', parts: ['Part one.'] },
    { item: 'a2', parts: ['Part two.'] },
  ]);

  // A pending interaction is content and never moves; nothing after the answer means no change.
  const pending = [item('a1', [text('Answer.')]), item('a2', [approval('q-3', 'pending')])];
  assert.deepEqual(shape(turnSegments(pending, { settled: true })), shape(turnSegments(pending)));
  const plain = [item('a1', [approval('q-4', 'answered')]), item('a2', [text('Answer.')])];
  assert.deepEqual(turnSegments(plain, { settled: true }), turnSegments(plain));
});

test('tool rows (Codex, ACP, Grok record each call as role "tool") fold with the assistant rows around them', () => {
  const row = (id: string, parts: ChatPart[]) => item(id, parts, { role: 'tool' });
  const user: ChatItem = { id: 'u1', role: 'user', turnId: 'turn', createdAt: 'now', parts: [text('Fix it')] };
  // Codex: thinking and commentary on assistant rows, every command or edit on its own tool row.
  const codex = [
    user,
    item('a1', [think('Where is it')]),
    row('cmd-1', [tool('cmd-1', 'failed')]),
    item('a2', [text('Retrying with the right path.', 'commentary')]),
    row('cmd-2', [tool('cmd-2')]),
    row('cmd-3', [tool('cmd-3')]),
    row('cmd-4', [tool('cmd-4')]),
    item('a3', [text('Done.', 'final_answer')]),
  ];
  assert.deepEqual(shape(turnSegments(codex, { collapseCommentary: true, settled: true })), [
    { item: 'u1', parts: ['Fix it'] },
    { fold: 'fold:a1:0', steps: ['thinking:Where is it', 'tool:cmd-1', 'commentary:Retrying with the right path.', 'tool:cmd-2', 'tool:cmd-3', 'tool:cmd-4'] },
    { item: 'a3', parts: ['Done.'] },
  ]);
  // A turn that opens with a tool row starts its fold there; text after a tool row is not the answer yet.
  const acp = [row('acp-tool-1', [tool('t1')]), item('a1', [text('Reading more.')]), row('acp-tool-2', [tool('t2')]), item('a2', [text('All set.')])];
  assert.deepEqual(shape(turnSegments(acp)), [
    { fold: 'fold:acp-tool-1:0', steps: ['tool:t1', 'commentary:Reading more.', 'tool:t2'] },
    { item: 'a2', parts: ['All set.'] },
  ]);
  // System rows still split segments and render whole.
  const system: ChatItem = { id: 's1', role: 'system', turnId: 'turn', createdAt: 'now', parts: [text('Context compacted')] };
  assert.deepEqual(shape(turnSegments([row('r1', [tool('t1')]), system, row('r2', [tool('t2')])])), [
    { fold: 'fold:r1:0', steps: ['tool:t1'] },
    { item: 's1', parts: ['Context compacted'] },
    { fold: 'fold:r2:0', steps: ['tool:t2'] },
  ]);
});
