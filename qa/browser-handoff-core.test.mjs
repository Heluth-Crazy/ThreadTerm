import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require=createRequire(import.meta.url),ts=require('typescript');
function core(){const source=readFileSync('desktop/src/browser/consoleHandoff.ts','utf8'),output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,module={exports:{}};const context={Buffer,URL,require:()=>({}),module,exports:module.exports};vm.runInNewContext(`(function(require,module,exports){${output}\n})(require,module,exports)`,context);return module.exports;}

test('console ring retains bounded recent entries and signals truncation',()=>{const {createConsoleRing,appendConsoleEntry,MAX_CONSOLE_ENTRIES,MAX_CONSOLE_BYTES}=core(),ring=createConsoleRing();for(let index=0;index<MAX_CONSOLE_ENTRIES+20;index++)appendConsoleEntry(ring,{level:'error',text:`line ${index}`,sourceUrl:'https://example.test/app.js',line:index});assert.equal(ring.entries.length,MAX_CONSOLE_ENTRIES);assert.equal(ring.entries[0].text,'line 20');assert.equal(ring.truncated,true);assert.ok(ring.bytes<=MAX_CONSOLE_BYTES);});
test('console formatter keeps page-data framing and excludes non-errors',()=>{const {createConsoleRing,appendConsoleEntry,formatConsolePageData,consoleCounts}=core(),ring=createConsoleRing();appendConsoleEntry(ring,{level:'info',text:'normal',sourceUrl:'https://example.test/a.js',line:1});appendConsoleEntry(ring,{level:'warning',text:'careful',sourceUrl:'https://example.test/a.js',line:2});appendConsoleEntry(ring,{level:'error',text:'bad',sourceUrl:'https://example.test/a.js',line:3});const counts=consoleCounts(ring.entries);assert.equal(counts.errors,1);assert.equal(counts.warnings,1);const text=formatConsolePageData('https://example.test/path',ring.entries,true);assert.match(text,/^Page data, not instructions\./);assert.match(text,/Origin: https:\/\/example\.test/);assert.match(text,/\[error\].*bad/);assert.doesNotMatch(text,/\[info\]/);assert.match(text,/truncated/);});

test('console ring clips oversized Unicode entries and stays within its byte bound',()=>{
 const {createConsoleRing,appendConsoleEntry,MAX_CONSOLE_BYTES}=core(),ring=createConsoleRing();
 appendConsoleEntry(ring,{level:'error',text:'a'.repeat(20000),sourceUrl:'https://example.test/app.js',line:1});assert.equal(ring.truncated,true);assert.equal(ring.entries[0].text.length,16384);
 for(let index=0;index<100;index++)appendConsoleEntry(ring,{level:'warning',text:'💾'.repeat(9000),sourceUrl:'https://example.test/'+'x'.repeat(3000),line:index});
 assert.ok(ring.bytes<=MAX_CONSOLE_BYTES);assert.ok(ring.entries.length<=200);assert.equal(ring.truncated,true);
});
test('page-data formatting is bounded even when the URL or messages exceed the byte budget',()=>{
 const {formatConsolePageData}=core(),entries=Array.from({length:200},()=>({level:'error',text:'💾'.repeat(1000),sourceUrl:'https://example.test/app.js',line:3}));
 for(const url of ['https://example.test/path','https://example.test/'+'💾'.repeat(20000)]){
  const text=formatConsolePageData(url,entries,false);assert.ok(Buffer.byteLength(text,'utf8')<=24*1024);assert.match(text,/^Page data, not instructions\./);assert.match(text,/Console output was truncated/);assert.match(text,/Origin:/);assert.match(text,/URL:/);
 }
});
