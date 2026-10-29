import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewDiff } from '@threadterm/protocol';
import { receiveReviewDiff, reviewSaveFingerprint, reviewDraftNeedsDeferral, type ReviewDiffRefresh } from './reviewDiffRefresh';

const disk=(fingerprint='one',newText='disk'):ReviewDiff=>({path:'a.txt',oldText:'checkpoint',newText,exists:true,binary:false,fingerprint});
const clean=():ReviewDiffRefresh=>({scope:'live',ticket:1,diff:disk(),text:'disk'});

test('current-side drafts defer binary and exists transitions even when both versions have empty text',()=>{
 const empty=disk('one','');
 assert.equal(reviewDraftNeedsDeferral(empty,{...empty,binary:true}),true);
 assert.equal(reviewDraftNeedsDeferral(empty,{...empty,exists:false}),true);
 assert.equal(reviewDraftNeedsDeferral({...empty,binary:true},empty),true);
 assert.equal(reviewDraftNeedsDeferral({...empty,exists:false},empty),true);
 assert.equal(reviewDraftNeedsDeferral(empty,{...empty,fingerprint:'two'}),false);
 assert.equal(reviewDraftNeedsDeferral(empty,disk('two','changed')),true);
 assert.equal(reviewDraftNeedsDeferral(undefined,empty),false);
});

test('only the latest response for the current props applies (including A → B → A)',()=>{
 const state={...clean(),ticket:3};
 assert.equal(receiveReviewDiff(state,'live',1,disk('old')),state);
 assert.equal(receiveReviewDiff(state,'other-path',3,disk('other')),state);
 assert.equal(receiveReviewDiff(state,'live',3,disk('latest')).diff?.fingerprint,'latest');
});
test('a clean response replaces disk text and clears conflict',()=>{
 const next=receiveReviewDiff({...clean(),conflict:true},'live',1,disk('two','fresh'));
 assert.equal(next.text,'fresh');assert.equal(next.diff?.fingerprint,'two');assert.equal(next.conflict,undefined);
});
test('edits made while a request is in flight survive a changed fingerprint',()=>{
 const next=receiveReviewDiff({...clean(),text:'my edits'},'live',1,disk('two','external'));
 assert.equal(next.text,'my edits');assert.equal(next.diff?.newText,'disk');
 assert.equal(next.conflict && next.conflict!==true && next.conflict.fingerprint,'two');
});
test('unchanged disk does not erase dirty text or invent a conflict',()=>{
 const next=receiveReviewDiff({...clean(),text:'my edits'},'live',1,disk());
 assert.equal(next.text,'my edits');assert.equal(next.conflict,undefined);
});
test('edits typed during Save stay dirty against the acknowledged write fingerprint',()=>{
 const acknowledged:ReviewDiffRefresh={...clean(),diff:disk('saved','submitted'),text:'typed after submit'};
 const next=receiveReviewDiff(acknowledged,'live',1,disk('saved','submitted'));
 assert.equal(next.text,'typed after submit');assert.equal(next.conflict,undefined);
 assert.equal(reviewSaveFingerprint(next),'saved');
});
test('Save cannot write in conflict, explicit overwrite uses the new disk fingerprint',()=>{
 const state=receiveReviewDiff({...clean(),text:'mine'},'live',1,disk('two','external'));
 assert.equal(reviewSaveFingerprint(state),undefined);
 assert.equal(reviewSaveFingerprint(state,{scope:'live',fingerprint:'two'}),'two');
 const newer=receiveReviewDiff(state,'live',1,disk('three','external again'));
 assert.equal(reviewSaveFingerprint(newer,{scope:'live',fingerprint:'three'}),'three');assert.equal(newer.text,'mine');
});
test('a write conflict without a readable disk snapshot blocks all saves until refresh succeeds',()=>{
 const state:ReviewDiffRefresh={...clean(),text:'mine',conflict:true};
 assert.equal(reviewSaveFingerprint(state),undefined);assert.equal(reviewSaveFingerprint(state,{scope:'live',fingerprint:'two'}),undefined);
 const refreshed=receiveReviewDiff(state,'live',1,disk('two'));
 assert.equal(reviewSaveFingerprint(refreshed,{scope:'live',fingerprint:'two'}),'two');
});
test('confirmed reload replaces dirty text; clean or missing fingerprints cannot save',()=>{
 const next=receiveReviewDiff({...clean(),text:'mine',conflict:true},'live',1,disk('two','fresh'),'mine');
 assert.equal(next.text,'fresh');assert.equal(next.conflict,undefined);assert.equal(reviewSaveFingerprint(next),undefined);
 assert.equal(reviewSaveFingerprint({...clean(),text:'mine',diff:{...disk(),fingerprint:undefined}}),undefined);
});
test('confirmed reload preserves edits typed after confirmation and captures fresh disk conflict',()=>{
 const next=receiveReviewDiff({...clean(),text:'typed after confirmation'},'live',1,disk('two','fresh'),'confirmed text');
 assert.equal(next.text,'typed after confirmation');assert.equal(next.diff?.newText,'disk');
 assert.equal(reviewSaveFingerprint(next),undefined);
 assert.equal(reviewSaveFingerprint(next,{scope:'live',fingerprint:'two'}),'two');
});
test('reload preserves new edits even when they match the old base; empty captured text is valid',()=>{
 const next=receiveReviewDiff(clean(),'live',1,disk('two','fresh'),'discard me');
 assert.equal(next.text,'disk');assert.equal(next.conflict && next.conflict!==true && next.conflict.fingerprint,'two');
 assert.equal(receiveReviewDiff({...clean(),text:''},'live',1,disk('two','fresh'),'').text,'fresh');
});
test('overwrite confirmation survives unchanged responses but rejects changed scope or fingerprint',()=>{
 const state=receiveReviewDiff({...clean(),text:'mine'},'live',1,disk('two','external'));
 const confirmation={scope:'live',fingerprint:'two'};
 const unchanged=receiveReviewDiff(state,'live',1,disk('two','external'));
 assert.notEqual(unchanged.conflict,state.conflict);
 assert.equal(reviewSaveFingerprint(unchanged,confirmation),'two');
 assert.equal(reviewSaveFingerprint({...unchanged,scope:'other'},confirmation),undefined);
 assert.equal(reviewSaveFingerprint(receiveReviewDiff(unchanged,'live',1,disk('three','new')),confirmation),undefined);
});
