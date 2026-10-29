import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pushDestination, pushRejectionAction, requiresForcePushBranchConfirmation} from './gitPushPreview';

test('push preview destination identifies a normal push and publication in both languages',()=>{
 const tracked={branch:'main',remote:'origin',remoteBranch:'main',setUpstream:false};
 const publish={branch:'feature-x',remote:'origin',remoteBranch:'feature-x',setUpstream:true};
 assert.equal(pushDestination(tracked,false),'Push main → origin/main');
 assert.equal(pushDestination(tracked,true),'推送 main → origin/main');
 assert.equal(pushDestination(publish,false),'Publish feature-x → origin/feature-x (sets upstream)');
 assert.equal(pushDestination(publish,true),'发布 feature-x → origin/feature-x（设置上游）');
});

test('force confirmation requires the explicit remote default or documented fallback branches',()=>{
 assert.equal(requiresForcePushBranchConfirmation({remoteBranch:'release',remoteDefaultBranch:'release'}),true);
 assert.equal(requiresForcePushBranchConfirmation({remoteBranch:'main',remoteDefaultBranch:'release'}),false);
 assert.equal(requiresForcePushBranchConfirmation({remoteBranch:'main'}),true);
 assert.equal(requiresForcePushBranchConfirmation({remoteBranch:'master'}),true);
 assert.equal(requiresForcePushBranchConfirmation({remoteBranch:'feature-x'}),false);
});

test('only classified push failures expose recovery actions',()=>{
 assert.equal(pushRejectionAction(new Error('push_rejected_non_ff: remote has commits')),'force');
 assert.equal(pushRejectionAction('push_lease_stale'),'refresh');
 assert.equal(pushRejectionAction('push_destination_changed'),'review');
 assert.equal(pushRejectionAction('push_rejected_hook: protected branch'),undefined);
 assert.equal(pushRejectionAction('git_failed: unexpected'),undefined);
});
