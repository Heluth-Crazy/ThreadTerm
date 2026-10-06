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
