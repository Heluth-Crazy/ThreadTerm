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

test('native completed history folds with unknown duration and retains explicit final segments', () => {
  const items = [item('plan', [{...text('checking'),phase:'commentary'}]),
    item('tool', [{type:'tool',toolName:'read'}]),
    item('answer-a', [{...text('first'),phase:'final_answer'}]),
    item('answer-b', [{...text('second'),phase:'final_answer'}]),
    item('boundary', [], {turnStatus:'completed'})];
  const original = JSON.stringify(items);
  const [turn] = groupCodexTranscript(items);
  assert.equal(turn.completed,true);
  assert.equal(turn.elapsedMs,undefined,'missing duration is not a zero-second turn');
  assert.deepEqual(turn.activity.map(row=>row.id),['plan','tool']);
  assert.deepEqual(turn.response.map(row=>row.id),['answer-a','answer-b']);
  assert.equal(JSON.stringify(items),original);
});

test('native unfinished outcomes remain visible even with duration metadata', () => {
  for(const turnStatus of ['inProgress','unknown']) {
    const rows=[item('plan',[{type:'thinking',text:'plan'}]),item('partial',[text('partial answer')]),
      item('boundary',[{type:'error',text:'native diagnostic'}],{turnStatus,elapsedMs:1200})];
    const [turn]=groupCodexTranscript(rows);
    assert.equal(turn.completed,false);
    assert.equal(turn.activity.length,0);
    assert.deepEqual(turn.response,rows,'no partial answer or failure is hidden');
  }
  const [unknown]=groupCodexTranscript([item('unknown',[text('no status')])]);
  assert.equal(unknown.completed,false);
});

test('failed and interrupted native turns settle while retaining partial answers and diagnostics',()=>{
  for(const turnStatus of ['failed','interrupted']) {
    const [turn]=groupCodexTranscript([item('thought',[{type:'thinking',text:'process'}]),item('partial',[text('partial answer')]),
      item('boundary',[{type:'error',text:'native diagnostic'}],{turnStatus})]);
    assert.equal(turn.completed,false);
    assert.equal(turn.settled,true);
    assert.deepEqual(turn.response.map(row=>row.id),['partial','boundary']);
    assert.deepEqual(turn.activity.map(row=>row.id),['thought']);
    const [empty]=groupCodexTranscript([item('zero-items',[],{turnStatus})]);
    assert.equal(empty.settled,true);
    assert.equal(empty.turnStatus,turnStatus,'empty terminal turns keep their visible outcome without inventing a reason');
  }
});

test('mixed native phase retains unclassified text rather than guessing it is commentary',()=>{
  const [turn]=groupCodexTranscript([item('unclassified',[text('answer segment without phase')]),
    item('plan',[{...text('known process'),phase:'commentary'}]),
    item('final',[{...text('final segment'),phase:'final_answer'}]),
    item('done',[],{turnStatus:'completed'})]);
  assert.deepEqual(turn.activity.map(row=>row.id),['plan']);
  assert.deepEqual(turn.response.map(row=>row.id),['unclassified','final']);
});

test('status cards remain standalone even when native turn identity matches adjacent records',()=>{
  const groups=groupCodexTranscript([item('before',[{type:'tool',toolName:'read'}]),
    item('status',[{type:'status',text:'native status'}]),
    item('after',[{type:'tool',toolName:'write'}]),item('done',[],{turnStatus:'completed'})]);
  assert.equal(groups.length,3);
  assert.equal(groups[0].completed,false);
  assert.equal(groups[1].response[0].parts[0].type,'status');
  assert.equal(groups[2].completed,true);
  assert.deepEqual(groups[2].activity.map(row=>row.id),['after']);
});
