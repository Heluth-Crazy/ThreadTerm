import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalScreen, terminalCommand, terminalViewportSize } from '../src/core/terminalScreen';

test('terminal screen applies CR redraws, clears, cursor movement and alternate screens',async()=>{
  const screen=new TerminalScreen(20,4);
  await screen.write('old\rnew');
  assert.equal(screen.lines()[0]?.text,'new');
  await screen.write('\x1b[2J\x1b[Hmain');
  assert.equal(screen.lines()[0]?.text,'main');
  await screen.write('\x1b[3;1Hrow three');
  assert.equal(screen.lines()[1]?.text,' ','cursor movement retains the blank second row');
  assert.equal(screen.lines()[2]?.text,'row three');
  await screen.write('\x1b[?1049halt\x1b[?1049l');
  assert.equal(screen.lines()[0]?.text,'main','the alternate screen does not pollute scrollback');
});

test('terminal screen receives split unicode text after the controller decoder joins it',async()=>{
  const screen=new TerminalScreen();await screen.write('€');
  assert.equal(screen.lines()[0]?.text,'€');
});

test('terminal Run uses CR and never turns a pasted newline into a second command',()=>{
  assert.equal(terminalCommand('echo one\ntwo'),'echo onetwo\r');
});

test('phone geometry fits whole cells and terminal resize reflows the screen',async()=>{
  assert.deepEqual(terminalViewportSize(374,215,8.5),{cols:44,rows:10});
  const screen=new TerminalScreen(10,3);
  try {
    await screen.write('1234567890X\r\n');
    assert.equal(screen.lines()[1]?.text,'X');
    screen.resize(5,3);
    assert.deepEqual(screen.lines().map(line=>line.text),['12345','67890','X',' ']);
    assert.equal(screen.lines()[3]?.cursorColumn,0);
  } finally { screen.dispose(); }
});

test('scrollback survives alternate-screen apps and pending parses settle on disposal',async()=>{
  const screen=new TerminalScreen(12,2);
  await screen.write('one\r\ntwo\r\nthree');
  const before=screen.lines().map(line=>line.text);
  assert.deepEqual(before,['one','two','three']);
  await screen.write('\x1b[?1049hALT');
  assert.equal(screen.lines().some(line=>line.text==='one'),false);
  await screen.write('\x1b[?1049l');
  assert.deepEqual(screen.lines().map(line=>line.text),before);
  const pending=screen.write('pending');screen.dispose();await pending;
});
