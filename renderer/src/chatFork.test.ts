import test from 'node:test';
import assert from 'node:assert/strict';
import type { PaneLayout } from '@threadterm/protocol';
import { forkDisabledReason, isCompletedForkReply, openForkInPane, peekForkNotice, rememberForkNotice, takeForkNotice } from './chatFork';

test('fork inserts once and activates in originating pane without changing its siblings', () => {
  const first: PaneLayout = {kind:'pane',id:'left',tabs:[{kind:'session',id:'source',sessionId:'source'}],activeTabId:'source'};
  const second: PaneLayout = {kind:'pane',id:'right',tabs:[{kind:'session',id:'other',sessionId:'other'}],activeTabId:'other'};
  const layout: PaneLayout = {kind:'split',id:'split',direction:'horizontal',ratio:0.5,first,second};
  const forked = openForkInPane(layout,'right','child');
  assert.equal(forked.kind,'split');
  if(forked.kind!=='split'||forked.second.kind!=='pane')throw Error('wrong shape');
  assert.equal(forked.first,first);
  assert.equal(forked.second.tabs.length,2);
  assert.equal(forked.second.activeTabId,'session:child');
  assert.deepEqual(openForkInPane(forked,'right','child'),forked);
  assert.equal(openForkInPane(layout,'removed','child'),layout);
});
test('fork running and pending states are disabled with localized explanations', () => {
  assert.match(forkDisabledReason(true,false,false)!,/turn is running/);
  assert.equal(forkDisabledReason(false,true,true),'正在分叉…');
  assert.equal(forkDisabledReason(false,false,false),undefined);
});
test('new-tab success notice is consumed once', () => {
  rememberForkNotice('child','copy');
  assert.equal(peekForkNotice('child'),'copy');
  assert.equal(peekForkNotice('child'),'copy');
  assert.equal(takeForkNotice('child'),'copy');
  assert.equal(takeForkNotice('child'),undefined);
});
test('only a completed answer is a valid fork action boundary', () => {
  const item = {id:'reply',role:'assistant' as const,parts:[{type:'text' as const,text:'answer',status:'complete' as const}],createdAt:'now',turnStatus:'completed' as const};
  assert.equal(isCompletedForkReply(item),true);
  for(const turnStatus of ['interrupted','failed','unknown','inProgress',undefined] as const)assert.equal(isCompletedForkReply({...item,turnStatus}),false);
  assert.equal(isCompletedForkReply({...item,role:'user'}),false);
  assert.equal(isCompletedForkReply({...item,parts:[{...item.parts[0],phase:'commentary'}]}),false);
  const reply={...item,turnId:'turn',turnStatus:undefined};
  const boundary={...item,id:'boundary',turnId:'turn',parts:[]};
  assert.equal(isCompletedForkReply(reply,[reply,boundary]),true);
  assert.equal(isCompletedForkReply(reply,[reply,{...boundary,turnStatus:'failed'}]),false);
  assert.equal(isCompletedForkReply(reply,[reply,{...boundary,turnStatus:'unknown'}]),false);
  assert.equal(isCompletedForkReply({...reply,turnOrigin:'history'}),true);
  assert.equal(isCompletedForkReply({...reply,turnOrigin:'history',turnStatus:'failed'}),false);
});
