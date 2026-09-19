import {test} from 'node:test';
import assert from 'node:assert/strict';
import {restoreChat,upsertChatItem} from '../renderer/src/chatState.ts';
const item=text=>({id:'assistant-turn',role:'assistant',createdAt:'now',parts:[{type:'text',text}]});
test('cumulative chat deltas replace the existing message',()=>{
  assert.deepEqual(upsertChatItem([item('A')],item('AB')),[item('AB')]);
});
test('snapshot ignores older buffered events and applies newer events in sequence',()=>{
  const result=restoreChat({items:[item('AB')],revision:4},[
    {seq:6,item:item('ABCD')},{seq:3,item:item('A')},{seq:5,item:item('ABC')}
  ]);
  assert.deepEqual(result,[item('ABCD')]);
});
