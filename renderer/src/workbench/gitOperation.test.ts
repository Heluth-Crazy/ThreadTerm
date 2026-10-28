import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitStatus } from '@threadterm/protocol';
import { gitOperationState, mergeResultMessage, pullDivergence } from './gitOperation';

const status:GitStatus={branch:'main',upstream:null,ahead:0,behind:0,changes:[]};
test('merge feedback preserves conflict instructions and warnings independently in both languages',()=>{
 for(const zh of [false,true]) {
  const conflict=mergeResultMessage({conflicted:true},zh);
  assert.match(conflict,zh?/完成合并/:/Conclude merge/);
  assert.doesNotMatch(conflict,/Merge completed|Merged upstream|合并已完成/);
  const warning=mergeResultMessage({conflicted:false,warning:'merge_completed_after_error'},zh);
  assert.match(warning,zh?/错误/:/error/);
  assert.equal(mergeResultMessage({conflicted:true,warning:'merge_completed_after_error'},zh),`${conflict} ${warning}`);
  assert.equal(mergeResultMessage({conflicted:false},zh),zh?'合并已完成。':'Merge completed.');
 }
});
test('merge banner counts all porcelain conflict kinds and requires staged resolution',()=>{
 const changes=['DD','AU','UD','UA','DU','AA','UU'].map((xy,index)=>({path:`${index}`,indexStatus:xy[0],worktreeStatus:xy[1],untracked:false}));
 const operation={kind:'merge' as const,head:'a'.repeat(40)};
 const conflicted=gitOperationState({...status,operation,changes},false)!;
 assert.equal(conflicted.conflicts,7);
 assert.equal(conflicted.canConclude,false);
 assert.equal(conflicted.label,'Merging aaaaaaa · 7 conflicts');
 assert.equal(gitOperationState({...status,operation},true)?.canConclude,false);
 assert.equal(gitOperationState({...status,operation,changes:[{path:'resolved',indexStatus:'M',worktreeStatus:' ',untracked:false}]},true)?.canConclude,true);
});
test('other operations are informational in both languages; absent operation has no banner',()=>{
 assert.equal(gitOperationState(status,false),undefined);
 for(const kind of ['rebase','cherry-pick','revert'] as const) for(const zh of [true,false]) {
  const banner=gitOperationState({...status,operation:{kind}},zh)!;
  assert.equal(banner.canConclude,false);
  assert.match(banner.label,zh?/终端/:/terminal/);
 }
});
test('divergence counts come only from the structured runtime error',()=>{
 assert.deepEqual(pullDivergence(new Error('pull_diverged: 12 3')),{ahead:12,behind:3});
 assert.deepEqual(pullDivergence('Error: pull_diverged: 1 2'),{ahead:1,behind:2});
 assert.equal(pullDivergence('git_failed: cannot fast-forward'),undefined);
 assert.equal(pullDivergence('pull_diverged: -1 2'),undefined);
});
