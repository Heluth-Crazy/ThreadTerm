import assert from 'node:assert/strict';
import {test} from 'node:test';
import {insertTerminalText,registerTerminalInputTarget} from './terminalInputTargets';
test('explicit insertion selects one visible target and never appends execution control characters',()=>{
  const calls:string[]=[];
  const remove=registerTerminalInputTarget('one',{visible:()=>true,insert:text=>calls.push(text)});
  const hidden=registerTerminalInputTarget('one',{visible:()=>false,insert:()=>assert.fail('hidden view')});
  insertTerminalText('one','git status --short');assert.deepEqual(calls,['git status --short']);
  assert.throws(()=>insertTerminalText('one','git status\n'),/single_line/);
  assert.throws(()=>insertTerminalText('one','git status\r'),/single_line/);
  assert.throws(()=>insertTerminalText('two','echo wrong-target'),/unavailable/);
  remove();hidden();assert.throws(()=>insertTerminalText('one','echo closed'),/unavailable/);
});

import {attachChatImages,insertChatText,registerChatInputTarget} from './terminalInputTargets';
import { cancelChatInputFocus, focusRequestedChatInput, requestChatInputFocus } from './terminalInputTargets';
test('new-chat focus is one-shot, waits for visible input and is cleared on close', () => {
  let visible = false, focused = 0;
  const remove = registerChatInputTarget('focus', { visible: () => visible, insert: () => assert.fail('focus must not insert'), focus: () => { focused++; } });
  requestChatInputFocus('focus'); assert.equal(focused, 0);
  visible = true; focusRequestedChatInput('focus'); focusRequestedChatInput('focus'); assert.equal(focused, 1);
  visible = false; requestChatInputFocus('focus'); cancelChatInputFocus('focus'); visible = true; focusRequestedChatInput('focus'); assert.equal(focused, 1); remove();
});
test('comment text and screenshots select the same visible Chat without submitting',()=>{
 const calls:string[]=[];
 const remove=registerChatInputTarget('chat',{visible:()=>true,insert:text=>calls.push(text),attachImages:images=>{calls.push(...images);return images.length;}});
 const hidden=registerChatInputTarget('chat',{visible:()=>false,insert:()=>assert.fail('hidden'),attachImages:()=>assert.fail('hidden')});
 insertChatText('chat','Page comments\nURL');assert.equal(attachChatImages('chat',['image']),1);
 assert.deepEqual(calls,['Page comments\nURL','image']);
 hidden();remove();assert.equal(attachChatImages('chat',['image']),0);
 const unsupported=registerChatInputTarget('plain',{visible:()=>true,insert:text=>calls.push(text)});
 insertChatText('plain','paths only');assert.equal(attachChatImages('plain',['image']),0);unsupported();
});
