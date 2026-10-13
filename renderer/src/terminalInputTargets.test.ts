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
test('composer focus survives startup effect replay and only a final close cancels it', async () => {
  let writable = false, focused = 0;
  const target = { visible: () => writable, insert: () => assert.fail('focus must not insert'), focus: () => { focused++; return true; } };
  requestChatInputFocus('replay');
  const replayCleanup = registerChatInputTarget('replay', target);
  replayCleanup();
  const remove = registerChatInputTarget('replay', target);
  await Promise.resolve(); // StrictMode's cleanup/setup completes before this boundary.
  writable = true; focusRequestedChatInput('replay'); focusRequestedChatInput('replay'); assert.equal(focused, 1);
  writable = false; requestChatInputFocus('replay'); remove(); await Promise.resolve();
  writable = true; const reopen = registerChatInputTarget('replay', target);
  focusRequestedChatInput('replay'); assert.equal(focused, 1, 'closed handoff cannot focus a later reopening'); reopen();
});
test('an unsuccessful DOM focus attempt stays pending until confirmed, or explicitly cancelled', () => {
  let acceptsFocus = false, attempts = 0;
  const remove = registerChatInputTarget('unfocused', { visible: () => true, insert: () => assert.fail(), focus: () => { attempts++; return acceptsFocus; } });
  requestChatInputFocus('unfocused'); assert.equal(attempts, 1);
  acceptsFocus = true; focusRequestedChatInput('unfocused'); focusRequestedChatInput('unfocused'); assert.equal(attempts, 2);
  acceptsFocus = false; requestChatInputFocus('unfocused'); cancelChatInputFocus('unfocused');
  acceptsFocus = true; focusRequestedChatInput('unfocused'); assert.equal(attempts, 3); remove();
});
test('a deferred close cannot cancel a newer handoff for the same session', async () => {
  const remove = registerChatInputTarget('newer', { visible: () => false, insert: () => assert.fail() });
  requestChatInputFocus('newer'); remove();
  requestChatInputFocus('newer'); await Promise.resolve();
  let focused = 0;
  const reopen = registerChatInputTarget('newer', { visible: () => true, insert: () => assert.fail(), focus: () => { focused++; return true; } });
  focusRequestedChatInput('newer'); assert.equal(focused, 1); reopen();
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
