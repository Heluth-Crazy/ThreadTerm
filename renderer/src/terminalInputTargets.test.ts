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
