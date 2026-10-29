import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeLatestUndo, latestUndo, noticeUndoId, publishLatestUndo, resetReceiptWithUndo, subscribeLatestUndo, undoEntryLabel, undoNoticeTimeout, undoRestoredPaths } from './gitUndo';

test('undo notices use the 30 second action window and ordinary notices keep the shared timeout',()=>{
 assert.equal(undoNoticeTimeout(true),30000);
 assert.equal(undoNoticeTimeout(false),4000);
});

test('undo entries preserve journal labels and localize compatibility fallbacks',()=>{
 assert.equal(undoEntryLabel({kind:'branch',label:'Delete topic',pathCount:0},false),'Delete topic');
 assert.equal(undoEntryLabel({kind:'branch',label:'Delete topic',pathCount:0},true),'删除 topic');
 assert.equal(undoEntryLabel({kind:'discard',label:'',pathCount:1},false),'Discarded changes in 1 file');
 assert.equal(undoEntryLabel({kind:'discard',label:'',pathCount:2},true),'丢弃 2 个文件的更改');
 assert.equal(undoEntryLabel({kind:'stash',label:'',pathCount:0},true),'删除暂存');
 assert.equal(undoEntryLabel({kind:'discard',label:'Discard 2 files',pathCount:2,partial:true},false),'Partially undone');
 assert.equal(undoEntryLabel({kind:'discard',label:'Discard 2 files',pathCount:2,partial:true},true),'部分已撤销');
});

test('discard labels count undoable and recycled paths separately',()=>{
 assert.equal(undoEntryLabel({kind:'discard',label:'Discard changes',pathCount:1,recycledCount:1},false),'Discarded changes in 1 file (1 more moved to the Recycle Bin)');
 assert.equal(undoEntryLabel({kind:'discard',label:'',pathCount:1,recycledCount:1},true),'丢弃 1 个文件的更改（另有 1 个已移到回收站）');
 assert.equal(undoEntryLabel({kind:'discard',label:'',pathCount:2},false),'Discarded changes in 2 files');
 assert.equal(undoEntryLabel({kind:'discard',label:'',pathCount:0,recycledCount:2},false),'2 files moved to the Recycle Bin');
 assert.equal(undoEntryLabel({kind:'discard',label:'',pathCount:0,recycledCount:2},true),'2 个文件已移到回收站');
});

test('a rejected Undo is only recognized as partially applied when it restored paths',()=>{
 for(const code of ['undo_conflict','undo_capture_unsupported','undo_capture_failed']) assert.equal(undoRestoredPaths(new Error(`${code}: completed=[a.txt]; remaining=[b.txt]`)),true);
 assert.equal(undoRestoredPaths(new Error('undo_conflict: completed=[]; remaining=[a.txt, b.txt]')),false);
 assert.equal(undoRestoredPaths(new Error('undo_conflict: a.txt')),false);
 assert.equal(undoRestoredPaths('undo_conflict: completed=[a.txt]'),true);
});
test('the Undo button is bound to the notice on screen and the matching journal entry',()=>{
 const latest={journalId:'discard-1'};
 assert.equal(noticeUndoId({message:'Changes discarded.',undoId:'discard-1'},latest),'discard-1');
 // A later unrelated notice replaces the object and drops its undo binding.
 assert.equal(noticeUndoId({message:'Pushed.'},latest),undefined);
 // A notice whose journal entry expired or was consumed no longer offers Undo.
 assert.equal(noticeUndoId({message:'Changes discarded.',undoId:'discard-1'},undefined),undefined);
 assert.equal(noticeUndoId({message:'Changes discarded.',undoId:'discard-1'},{journalId:'reset-1'}),undefined);
 assert.equal(noticeUndoId(undefined,latest),undefined);
});

test('a reset receipt is retired when its journal notice is consumed, expires, or is superseded',()=>{
 const receipt={operation:'reset-op',undoId:'reset-1'};
 assert.deepEqual(resetReceiptWithUndo(receipt,{journalId:'reset-1'}),receipt);
 assert.equal(resetReceiptWithUndo(receipt,{journalId:'discard-1'}),undefined);
 assert.equal(resetReceiptWithUndo(receipt,undefined),undefined);
 // The legacy receipt (no journal entry) keeps its own reset fence and Undo path.
 const legacy:{operation:string;undoId?:string}={operation:'reset-op'};
 assert.deepEqual(resetReceiptWithUndo(legacy,undefined),legacy);
});

test('a newer worktree notice supersedes the earlier action across surfaces',()=>{
 const key='project\0worktree';
 const updates:string[]=[];
 const unsubscribe=subscribeLatestUndo(key,()=>updates.push(latestUndo(key,1_000)?.journalId ?? 'none'));
 publishLatestUndo(key,{journalId:'discard',kind:'discard',label:'Discarded changes'},0);
 publishLatestUndo(key,{journalId:'reset',kind:'reset',label:'Reset branch'},1);
 assert.equal(latestUndo(key,2)?.journalId,'reset');
 consumeLatestUndo(key,'discard',2);
 assert.equal(latestUndo(key,2)?.journalId,'reset');
 consumeLatestUndo(key,'reset',2);
 assert.equal(latestUndo(key,2),undefined);
 unsubscribe();
 assert.deepEqual(updates,['discard','reset','none']);
});

test('an expired worktree notice cannot be used',()=>{
 const key='project\0expired';
 publishLatestUndo(key,{journalId:'discard',kind:'discard',label:'Discarded changes'},0);
 assert.equal(latestUndo(key,undoNoticeTimeout(true)-1)?.journalId,'discard');
 assert.equal(latestUndo(key,undoNoticeTimeout(true)),undefined);
});
