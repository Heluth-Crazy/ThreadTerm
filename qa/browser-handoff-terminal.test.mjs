import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('isolated handoff terminal accepts fragmented commands and emits no duplicate Vite offer',()=>{
 const stdin=new EventEmitter(),output=[];stdin.resume=()=>{};
 vm.runInNewContext(readFileSync('qa/fixtures/browser-handoff-terminal.mjs','utf8'),{process:{argv:[],stdin,stdout:{write:text=>output.push(text)},env:{THREADTERM_QA_BROWSER_URL:'http://127.0.0.1:5173'}}});
 for(const chunk of ['emit-','vite','\r','\n','emit-vite\r\nemit-','link\r\n'])stdin.emit('data',chunk);
 assert.deepEqual(output,['  Local:   http://127.0.0.1:5173\r\n','\x1b[2J\x1b[Hhttp://127.0.0.1:5173/toolbar-link\r\n']);
});
