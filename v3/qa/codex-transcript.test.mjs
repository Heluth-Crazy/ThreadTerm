import assert from 'node:assert/strict';
import test from 'node:test';
import { groupCodexTranscript } from '../renderer/src/codexTranscript.ts';

const item = (id, parts, extras = {}) => ({ id, role: 'assistant', turnId: 'turn-1', createdAt: 'now', parts, ...extras });
const text = value => ({ type: 'text', text: value });
test('completion record folds commentary and tools, retaining the final answer', () => {
  const items = [item('u', [text('测试消息')], { role: 'user' }), item('a', [text('先检查项目')]),
    item('tool', [{ type: 'tool', toolName: 'commandExecution' }]), item('answer', [text('完成')]),
    item('done', [], { elapsedMs: 22000 })];
  const original = JSON.stringify(items);
  const [user, turn] = groupCodexTranscript(items);
  assert.equal(user.response[0].id, 'u');
  assert.equal(turn.elapsedMs, 22000);
  assert.deepEqual(turn.activity.map(item => item.id), ['a', 'tool']);
  assert.deepEqual(turn.response.map(item => item.id), ['answer']);
  assert.equal(JSON.stringify(items), original);
});
test('unfinished turns stay visible and user boundaries prevent cross-turn folding', () => {
  const groups = groupCodexTranscript([item('a', [text('working')]), item('u', [text('next')], { role: 'user' }),
    item('b', [text('reply')], { elapsedMs: 0 })]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].activity.length, 0);
  assert.equal(groups[0].response[0].id, 'a');
  assert.equal(groups[2].elapsedMs, 0);
});
test('mixed parts retain final text, errors, failed tools and pending approvals outside disclosure', () => {
  const parts = [{ type: 'thinking', text: 'plan' }, text('answer'), { type: 'approval', status: 'pending' },
    { type: 'error', text: 'problem' }, { type: 'tool', status: 'failed' }, { type: 'usage' }];
  const [turn] = groupCodexTranscript([item('a', parts, { elapsedMs: 1000 })]);
  assert.deepEqual(turn.activity[0].parts.map(part => part.type), ['thinking']);
  assert.deepEqual(turn.response[0].parts.map(part => part.type), ['text', 'approval', 'error', 'tool']);
});
test('status and unknown turn identities are not swallowed by another turn', () => {
  const groups = groupCodexTranscript([item('a', [text('one')], { turnId: undefined }),
    item('b', [text('two')], { turnId: undefined, elapsedMs: 2000 }),
    item('s', [{ type: 'status' }]), item('c', [text('three')], { turnId: 'turn-2' })]);
  assert.equal(groups.length, 4);
  assert.equal(groups[2].response[0].parts[0].type, 'status');
});

test('shared presentation folds Kimi reasoning but preserves split answer and quota parts', () => {
  const parts = [{ type: 'thinking', text: 'reasoning' }, text('answer one')];
  const [turn] = groupCodexTranscript([item('a', parts), item('b', [text('answer two'), {type:'text',text:'Plan usage',data:{kind:'plan'}}], {elapsedMs:4000})], false);
  assert.equal(turn.elapsedMs, 4000);
  assert.deepEqual(turn.activity.flatMap(item => item.parts.map(part => part.type)), ['thinking']);
  assert.deepEqual(turn.response.flatMap(item => item.parts.map(part => part.text)), ['answer one', 'answer two', 'Plan usage']);
});
