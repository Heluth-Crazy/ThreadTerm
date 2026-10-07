import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explorerFileMenuItems, fileTabMenuItems, historyCommitMenuItems, historyVersionMenuItems, sourceControlMenuItems } from './contextMenuSurfaceItems';

test('Source Control rows keep target actions first and destructive discard last', () => {
 const items=sourceControlMenuItems({zh:false,staged:false,conflict:false,discardable:true,busy:true,canSend:false});
 assert.deepEqual(items.map(item=>item.id),['source-control-send-diff','source-control-stage','source-control-open-changes','source-control-copy-path','source-control-separator','source-control-discard']);
 assert.equal(items[0].reason,'Open a Chat session in this workspace first.');
 assert.equal(items.at(-1)?.danger,true);
 assert.equal(items.at(-1)?.reason,'Another Git action is running.');
});

test('history version labels precise lines and blocks unavailable actions', () => {
 const items=historyVersionMenuItems({zh:false,startLine:12,endLine:20,canComment:false,hasText:false,path:'src/a.ts'});
 assert.equal(items[0].label,'Comment on lines 12–20');
 assert.equal(items[0].reason,'Comments are unavailable for this file version.');
 assert.equal(items[1].reason,'Select text first.');
 assert.equal(items[2].id,'history-copy-path');
});

test('conflict rows use the existing resolved-stage label and commit sends remain visible when unavailable', () => {
 assert.equal(sourceControlMenuItems({zh:false,staged:false,conflict:true,discardable:false,busy:false,canSend:true})[1].label,'Mark resolved (stage)');
 assert.equal(historyCommitMenuItems({zh:false,canSend:false})[0].reason,'Open a Chat session in this workspace first.');
});

test('file tabs only expose actions backed by their host capabilities', () => {
 assert.deepEqual(fileTabMenuItems({zh:false,canSend:false,canCopy:false}),[]);
 assert.deepEqual(fileTabMenuItems({zh:false,canSend:true,plansLabel:'Add to Plans & docs',canCopy:true}).map(item=>item.label),['Send file to agent','Add to Plans & docs','Copy path']);
});

test('Explorer preserves its existing agent and document menu labels', () => {
 assert.deepEqual(explorerFileMenuItems({zh:false,canHistory:true,canSend:true,plansLabel:'Add to Plans & docs'}).map(item=>item.label),['File history','Send to agent','Add to Plans & docs','Copy path']);
});
