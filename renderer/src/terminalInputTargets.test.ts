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
test('a same-turn focus miss is retried on the next frame and a cancel drops the burst', () => {
  const frames: Array<(time: number) => void> = [];
  const previous = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  const canceled: number[] = [];
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = handle => { canceled.push(handle); };
  try {
    let accepts = false, attempts = 0;
    const remove = registerChatInputTarget('frame', { visible: () => true, insert: () => assert.fail(), focus: () => { attempts++; return accepts; } });
    requestChatInputFocus('frame');
    assert.equal(attempts, 1);
    assert.equal(frames.length, 1);
    cancelChatInputFocus('frame');
    assert.equal(canceled.length, 1);
    frames[0](0);
    assert.equal(attempts, 1, 'cancelled burst does not focus again');
    accepts = false; attempts = 0; frames.length = 0;
    requestChatInputFocus('frame');
    assert.equal(attempts, 1);
    assert.equal(frames.length, 1);
    accepts = true;
    frames[0](0);
    assert.equal(attempts, 2);
    focusRequestedChatInput('frame');
    assert.equal(attempts, 3, 'one successful frame does not consume the handoff');
    for (let i = 0; i < 14; i++) frames[frames.length - 1](0);
    const settled = attempts;
    focusRequestedChatInput('frame');
    assert.equal(attempts, settled, 'focus that stays for several frames consumes the handoff');
    remove();
  } finally {
    globalThis.requestAnimationFrame = previous;
    globalThis.cancelAnimationFrame = previousCancel;
  }
});
test('a handoff keeps retrying while the composer is not visible yet', () => {
  const frames: Array<(time: number) => void> = [];
  const previous = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    let visible = false, attempts = 0;
    const remove = registerChatInputTarget('late', { visible: () => visible, insert: () => assert.fail(), focus: () => { attempts++; return true; } });
    requestChatInputFocus('late');
    assert.equal(attempts, 0);
    assert.equal(frames.length, 1);
    frames[0](0);
    assert.equal(attempts, 0, 'a hidden composer does not abort the handoff');
    assert.equal(frames.length, 2);
    visible = true;
    frames[1](0);
    assert.equal(attempts, 1);
    for (let i = 0; i < 14; i++) frames[frames.length - 1](0);
    const settled = attempts;
    focusRequestedChatInput('late');
    assert.equal(attempts, settled, 'focus that stays consumes the handoff');
    remove();
  } finally {
    globalThis.requestAnimationFrame = previous;
    globalThis.cancelAnimationFrame = previousCancel;
  }
});
test('a composer that disables after the first focus is focused again once it stays enabled', () => {
  const frames: Array<(time: number) => void> = [];
  const previous = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    let visible = true, attempts = 0;
    const remove = registerChatInputTarget('flicker', { visible: () => visible, insert: () => assert.fail(), focus: () => { attempts++; return true; } });
    requestChatInputFocus('flicker');
    assert.equal(attempts, 1);
    frames[0](0);
    assert.equal(attempts, 2);
    visible = false;
    frames[frames.length - 1](0);
    assert.equal(attempts, 2, 'a disabled composer does not end the handoff');
    visible = true;
    frames[frames.length - 1](0);
    assert.equal(attempts, 3, 'the handoff focuses again after the composer is enabled');
    for (let i = 0; i < 14; i++) frames[frames.length - 1](0);
    const settled = attempts;
    focusRequestedChatInput('flicker');
    assert.equal(attempts, settled, 'focus that stays consumes the handoff');
    remove();
  } finally {
    globalThis.requestAnimationFrame = previous;
    globalThis.cancelAnimationFrame = previousCancel;
  }
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
test('an exhausted focus burst expires the pending handoff instead of focusing a later composer', () => {
  const frames: Array<(time: number) => void> = [];
  const previous = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    let accepts = false, attempts = 0;
    const remove = registerChatInputTarget('expire', { visible: () => true, insert: () => assert.fail(), focus: () => { attempts++; return accepts; } });
    requestChatInputFocus('expire');
    assert.equal(attempts, 1);
    // Never confirm focus while draining the bounded burst.
    for (let i = 0; i < 130 && frames.length; i++) frames[frames.length - 1](0);
    const exhausted = attempts;
    accepts = true;
    focusRequestedChatInput('expire');
    assert.equal(attempts, exhausted, 'an expired handoff cannot focus a later composer');
    remove();
  } finally {
    globalThis.requestAnimationFrame = previous;
    globalThis.cancelAnimationFrame = previousCancel;
  }
});
