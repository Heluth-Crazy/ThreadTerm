import assert from 'node:assert/strict';
import test from 'node:test';
import { historyActionSelection, resetDialogPreview, resetUndoMatchesBranch } from './gitHistoryActions';

const commits=(count:number)=>Array.from({length:count},(_,index)=>({hash:index.toString(16).padStart(40,'0'),subject:`commit ${index+1}`}));

test('reset preview retains all twenty listed commits without a remainder',()=>{
 const preview=resetDialogPreview({count:20,commits:commits(20),pushed:false});
 assert.equal(preview.commits.length,20);
 assert.equal(preview.remaining,0);
 assert.equal(preview.pushed,false);
});

test('reset preview bounds a longer range and retains the pushed warning fact',()=>{
 const preview=resetDialogPreview({count:21,commits:commits(21),pushed:true});
 assert.equal(preview.commits.length,20);
 assert.equal(preview.remaining,1);
 assert.equal(preview.pushed,true);
});

test('a direct clean cherry-pick or revert result selects its returned HEAD',()=>{
 assert.equal(historyActionSelection({conflicted:false,head:'c'.repeat(40)}),'c'.repeat(40));
});

test('a conflicted result never supplies a later selection intent',()=>{
 assert.equal(historyActionSelection({conflicted:true,head:'a'.repeat(40)}),undefined);
 // Continue, Abort and external operations only trigger refresh; no status enters this helper.
 assert.equal(historyActionSelection({conflicted:true}),undefined);
});

test('direct results preserve explicit History targets',()=>{
 for(const conflicted of [false,true])assert.equal(historyActionSelection({conflicted,head:'c'.repeat(40)},'explicit-target'),undefined);
});

test('a clean result without a HEAD cannot select a commit',()=>{
 assert.equal(historyActionSelection({conflicted:false}),undefined);
});

test('Undo visibility is bound to the original branch, including detached HEAD',()=>{
 assert.equal(resetUndoMatchesBranch('refs/heads/main','main'),true);
 assert.equal(resetUndoMatchesBranch('refs/heads/main','other'),false);
 assert.equal(resetUndoMatchesBranch('refs/heads/main',null),false);
 assert.equal(resetUndoMatchesBranch('detached',null),true);
 assert.equal(resetUndoMatchesBranch('detached','main'),false);
 assert.equal(resetUndoMatchesBranch('refs/heads/feature/topic','feature/topic'),true);
 assert.equal(resetUndoMatchesBranch('refs/heads/main',undefined),false);
});
