import assert from 'node:assert/strict';
import test from 'node:test';
import {appendTerminalChunk} from '../src/core/terminalStream';

test('terminal chunks retain raw split UTF-8, stable sequences and explicit stream resets',()=>{
  const one=appendTerminalChunk(undefined,new Uint8Array([0xe2]),0,1,false);
  const two=appendTerminalChunk(one,new Uint8Array([0x82,0xac]),1,3,false);
  assert.equal(Buffer.concat(two.chunks.map(c=>Buffer.from(c.data,'base64'))).toString(),'€');
  assert.deepEqual(two.chunks.map(c=>[c.seq,c.from,c.to]),[[1,0,1],[2,1,3]]);
  assert.equal(appendTerminalChunk(two,new Uint8Array(),3,3,false),two,'empty polls preserve identity');
  const reset=appendTerminalChunk(two,new Uint8Array([65]),10,11,true);
  assert.equal(reset.epoch,1);assert.equal(reset.seq,3);assert.equal(reset.chunks.length,1);
});
