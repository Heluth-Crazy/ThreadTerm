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
 assert.equal(historyCommitMenuItems({zh:false,canSend:false}).find(item=>item.id==='history-send-to-agent')?.reason,'Open a Chat session in this workspace first.');
});

test('history actions follow commit reachability and preserve existing targets', () => {
 const detached=historyCommitMenuItems({zh:false,canSend:true,includeActions:true,branch:'main',detached:true,isAncestor:false,operation:false});
 assert.equal(detached.map(item=>item.id).join(','),'history-new-branch,history-new-worktree,history-cherry-pick,history-revert,history-reset,history-separator,history-send-to-agent,history-copy-commit-hash');
 assert.equal(detached.find(item=>item.id==='history-cherry-pick')?.disabled,true);
 assert.equal(detached.find(item=>item.id==='history-reset')?.disabled,true);
 assert.equal(detached.find(item=>item.id==='history-new-branch')?.reason,undefined);
 assert.equal(detached.find(item=>item.id==='history-new-worktree')?.reason,undefined);
 const reached=historyCommitMenuItems({zh:false,canSend:true,includeActions:true,branch:'main',isAncestor:true});
 assert.equal(reached.find(item=>item.id==='history-cherry-pick')?.disabled,true);
 assert.equal(reached.find(item=>item.id==='history-reset')?.disabled,false);
 assert.equal(reached.at(-1)?.id,'history-copy-commit-hash');
});

test('file tabs only expose actions backed by their host capabilities', () => {
 assert.deepEqual(fileTabMenuItems({zh:false,canSend:false,canCopy:false}),[]);
 assert.deepEqual(fileTabMenuItems({zh:false,canSend:true,plansLabel:'Add to Plans & docs',canCopy:true}).map(item=>item.label),['Send file to agent','Add to Plans & docs','Copy path']);
});

test('Explorer preserves its existing agent and document menu labels', () => {
 assert.deepEqual(explorerFileMenuItems({zh:false,canHistory:true,canSend:true,plansLabel:'Add to Plans & docs'}).map(item=>item.label),['File history','Send to agent','Add to Plans & docs','Copy path']);
});

test('history action labels and blocked states are shared with header buttons without changing other commit menus',()=>{
 const find=(options:Parameters<typeof historyCommitMenuItems>[0],id:string)=>historyCommitMenuItems(options).find(item=>item.id===id)!;
 const options={zh:false,canSend:true,includeActions:true,branch:'feature/topic',isAncestor:false};
 assert.equal(find(options,'history-cherry-pick').label,'Cherry-pick into feature/topic');
 assert.equal(find(options,'history-reset').label,'Reset feature/topic to here…');
 for(const patch of [{operation:true},{busy:true},{ready:false},{detached:true}])assert.equal(find({...options,...patch},'history-cherry-pick').disabled,true);
 assert.equal(find({...options,isAncestor:true},'history-reset').disabled,false);
 assert.equal(find({...options,isAncestor:true,operation:true},'history-reset').disabled,true);
 assert.deepEqual(historyCommitMenuItems({zh:false,canSend:true}).map(item=>item.id),['history-send-to-agent','history-copy-commit-hash']);
});
