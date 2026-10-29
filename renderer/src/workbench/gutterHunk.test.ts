import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { canUseGitHunks, buildGitHunks, adjacentGitHunk, hunkAtPosition, hunkPreview, indexChunkContent, revertGitHunk } from './gutterHunk';
import { stageChunk, withLineBreaks } from './indexEdit';

function chunks(base:string,buffer:string){return buildGitHunks(base,EditorState.create({doc:buffer}).doc);}
function apply(buffer:string,spec:{from:number;to:number;insert:string}){return buffer.slice(0,spec.from)+spec.insert+buffer.slice(spec.to);}

test('builds the marker diff and finds added, modified, and deleted marker lines',()=>{
 const added='added\none\ntwo\n',addedDoc=EditorState.create({doc:added}).doc;
 assert.equal(hunkAtPosition(buildGitHunks('one\ntwo\n',addedDoc),addedDoc,0),0);
 const modified='one\nTWO\n',modifiedDoc=EditorState.create({doc:modified}).doc;
 assert.equal(hunkAtPosition(buildGitHunks('one\ntwo\n',modifiedDoc),modifiedDoc,modified.indexOf('TWO')),0);
 assert.equal(hunkAtPosition(buildGitHunks('one\ntwo\n',modifiedDoc),modifiedDoc,0),-1);
 const deleted='one\nthree\n',deletedDoc=EditorState.create({doc:deleted}).doc;
 assert.equal(hunkAtPosition(buildGitHunks('one\ntwo\nthree\n',deletedDoc),deletedDoc,deleted.indexOf('three')),0);
});

test('moves between hunks without wrap-around',()=>{
 const all=chunks('a\nb\nc\nd\n','A\nb\nC\nd\n');
 assert.equal(adjacentGitHunk(all,-1,1),0);
 assert.equal(adjacentGitHunk(all,all[0].fromB,1),1);
 assert.equal(adjacentGitHunk(all,all[1].fromB,1),-1);
 assert.equal(adjacentGitHunk(all,all[1].toB,-1),1);
 assert.equal(adjacentGitHunk(all,all[0].fromB,-1),-1);
 const deleted=chunks('one\ntwo\n','one\n')[0];
 assert.equal(adjacentGitHunk([deleted],deleted.fromB,-1),-1);
});

test('reverts additions, modifications, deletions, EOF, and CRLF bases with CodeMirror offsets',()=>{
 for(const [base,buffer] of [
  ['one\ntwo\n','one\nadded\ntwo\n'],
  ['one\ntwo\n','one\nTWO\n'],
  ['one\ntwo\nthree','one\nthree'],
  ['one\ntwo','one\nTWO'],
  ['one\r\ntwo\r\n','one\nTWO\n'],
 ] as const){
  const chunk=chunks(base,buffer)[0],spec=revertGitHunk(base,buffer,chunk);
  assert.equal(apply(buffer,spec),base.replace(/\r\n?/g,'\n'));
 }
});

test('uses the same stage computation and restores raw index line endings',()=>{
 const base='one\r\ntwo\r\n',buffer='one\ntwo changed\n',chunk=chunks(base,buffer)[0];
 assert.equal(indexChunkContent(base,buffer,chunk,false,base),withLineBreaks(stageChunk(base.replace(/\r\n?/g,'\n'),buffer,chunk),base));
});

test('previews base lines before current lines and reports lines beyond its cap',()=>{
 const base='one\ntwo\nthree\n',buffer='one\nTWO\nadded\nthree\n',chunk=chunks(base,buffer)[0];
 assert.deepEqual(hunkPreview(base,buffer,chunk,2),{lines:[{kind:'removed',text:'two'},{kind:'added',text:'TWO'}],remaining:1});
 assert.deepEqual(hunkPreview(base,buffer,chunk).lines,[{kind:'removed',text:'two'},{kind:'added',text:'TWO'},{kind:'added',text:'added'}]);
});


test('deleted-only previews omit additions and the default preview cap is 200 lines',()=>{
 const base='one\ntwo\nthree',buffer='one\nthree',deleted=chunks(base,buffer)[0];
 assert.deepEqual(hunkPreview(base,buffer,deleted),{lines:[{kind:'removed',text:'two'}],remaining:0});
 const large=Array.from({length:240},(_,index)=>`added ${index}`).join('\n'),chunk=chunks('anchor\n','anchor\n'+large)[0],preview=hunkPreview('anchor\n','anchor\n'+large,chunk);
 assert.equal(preview.lines.length,200);assert.equal(preview.remaining,41);
});

test('EOF addition and deletion without a trailing newline round-trip through a buffer revert',()=>{
 for(const [base,buffer] of [['one','one\ntwo'],['one\ntwo','one'],['','added'],['removed','']] as const){
  const chunk=chunks(base,buffer)[0];assert.equal(apply(buffer,revertGitHunk(base,buffer,chunk)),base);
 }
});

test('gutter popup guard rejects read-only, conflicted and conflict-block editors consistently',()=>{
 for(const readOnly of [false,true])for(const conflicted of [false,true])for(const hasConflictBlocks of [false,true])assert.equal(canUseGitHunks(readOnly,conflicted,hasConflictBlocks),!readOnly&&!conflicted&&!hasConflictBlocks);
});
