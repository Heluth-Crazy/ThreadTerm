import test from 'node:test';
import assert from 'node:assert/strict';
import { externalFileError, externalSelectionText, externalSelectionQuote, openExternalPaths, type ExternalOpenTarget } from './externalFiles';
import { EditorState } from '@codemirror/state';
import { externalFileDrop } from './externalFileDrop';
import { FILE_DRAG_TYPE, fileDragData, readFileDrag } from './fileDrag';

test('explicit external actions preserve owner scope, canonical paths and normal workspace redirects',async()=>{
 const opened:ExternalOpenTarget[]=[],requests:unknown[]=[];
 await openExternalPaths({paths:['outside','inside'],source:'link',sessionId:'chat',projectId:'project',projectPath:'/workspace',line:3,column:2,zh:false,onOpen:target=>{opened.push(target);},onNotice:()=>assert.fail()},async params=>{
  requests.push(params);
  return params.path==='outside'?{file:{id:'external',path:'/other/readme.md',name:'readme.md',image:false,size:5,modifiedAt:'',openedAt:''}}:{inWorkspace:{projectId:'project',worktreePath:'/workspace',path:'src/inside.ts'}};
 });
 assert.deepEqual(requests,[{path:'outside',source:'link',sessionId:'chat'},{path:'inside',source:'link',sessionId:'chat'}]);
 assert.equal(opened[0].path,'/other/readme.md');assert.equal(opened[0].ownerSessionId,'chat');assert.equal(opened[0].externalId,'external');assert.equal(opened[0].kind,'preview');assert.equal(opened[0].line,3);
 assert.equal(opened[1].externalId,undefined);assert.equal(opened[1].worktreePath,undefined);assert.equal(opened[1].path,'src/inside.ts');
});
test('multi-open caps work and aggregates mapped failures into one notice',async()=>{
 const notices:string[]=[];let calls=0;
 await openExternalPaths({paths:Array.from({length:12},(_,index)=>`/outside/${index}`),source:'drop',sessionId:'chat',projectId:'project',zh:true,onOpen:()=>assert.fail(),onNotice:text=>notices.push(text)},async()=>{calls++;throw {code:'external_file_unavailable'};});
 assert.equal(calls,10);assert.equal(notices.length,1);assert.match(notices[0],/无法访问/);assert.match(notices[0],/10/);
 assert.match(externalFileError(new Error('binary_file'),false),/UTF-8/);
});
test('external selection quote preserves text, lines and bounded UTF-8 without broken characters',()=>{
 const quote=externalSelectionQuote('/outside/a.ts','line one\nline two',4,5);
 assert.equal(quote.sourceTitle,'/outside/a.ts:4-5');assert.equal(quote.text,'line one\nline two');
 for(const text of [Array.from({length:250},()=> 'row').join('\n'),'多😀'.repeat(20000)]){
  const bounded=externalSelectionQuote('/outside/a.ts',text,1,250);
  assert.ok(new TextEncoder().encode(bounded.text).length<=16*1024);assert.ok(bounded.text.split('\n').length<=200);assert.match(bounded.text,/Selection truncated/);assert.ok(!bounded.text.includes('\ufffd'));
 }
});
test('external quotes include exactly a partial selection without adjacent unselected characters',()=>{
 const document='private prefix selected words private suffix\nnext line';
 const from=document.indexOf('selected'),to=from+'selected words'.length;
 const state=EditorState.create({doc:document,selection:{anchor:from,head:to}});
 const quote=externalSelectionQuote('/outside/file.ts',externalSelectionText(state),1,1);
 assert.equal(quote.text,'selected words');assert.ok(!quote.text.includes('private'));
 const cursor=EditorState.create({doc:document,selection:{anchor:document.indexOf('next')}});
 assert.equal(externalSelectionText(cursor),'next line','cursor-only send explicitly includes just its current line');
});
test('pane native-drop handler uses injected paths and leaves composer/internal drags to existing flows',()=>{
 const file={} as File,transfer={types:['Files'],files:[file]} as unknown as Pick<DataTransfer,'types'|'files'>;
 const opened:unknown[]=[];const open=(paths:string[],source:'drop')=>opened.push({paths,source});
 assert.equal(externalFileDrop(transfer,false,()=>'/outside/file.ts',open),true);
 assert.deepEqual(opened,[{paths:['/outside/file.ts'],source:'drop'}]);
 assert.equal(externalFileDrop(transfer,true,()=>assert.fail(),open),false);
 assert.equal(externalFileDrop({...transfer,types:['Files',FILE_DRAG_TYPE]},false,()=>assert.fail(),open),false);
 assert.equal(externalFileDrop(transfer,false,undefined,open),true);assert.equal(opened.length,1);
});
test('external tab drags preserve absolute references while unregistered absolute drags remain rejected',()=>{
 for(const path of ['/outside/file.ts','C:\\outside\\file.ts','\\\\server\\share\\file.ts']){
  const file={projectId:'project',path,externalId:'external'};
  assert.deepEqual(readFileDrag(fileDragData(file)),file);
  assert.equal(readFileDrag(fileDragData({projectId:'project',path})),undefined);
 }
 assert.equal(readFileDrag(fileDragData({projectId:'project',path:'relative.ts',externalId:'external'})),undefined);
});
