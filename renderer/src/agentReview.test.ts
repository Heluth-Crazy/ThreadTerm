import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentReviewFinding } from '@threadterm/protocol';
import { MAX_REVIEW_COMMENT_BODY } from './reviewComments';
import { defaultReviewAgent, findingCommentInput, reviewScopeLabel } from './agentReview';

test('chooses an installed chat agent other than the reviewed session agent', () => {
 assert.equal(defaultReviewAgent([{id:'codex',name:'Codex',installed:true,chat:true,terminal:true,history:true,resume:true},{id:'review-echo',name:'Echo',installed:true,chat:true,terminal:false,history:false,resume:false}], 'codex'), 'review-echo');
});
test('labels both review scopes', () => {
 assert.equal(reviewScopeLabel({kind:'checkpoints',from:'one'}, false), 'Changes from one to now');
 assert.equal(reviewScopeLabel({kind:'uncommitted'}, true), '未提交的改动');
});
test('creates a bounded current-file comment only for anchored findings', () => {
  const finding:AgentReviewFinding = {id:'finding',severity:'high',path:'src/file.ts',line:3,title:'Title',body:'x'.repeat(MAX_REVIEW_COMMENT_BODY),state:'open'};
  const input = findingCommentInput(finding, {projectId:'project',root:'/repo',text:'const value = 1;'});
 assert.equal(input?.body.length, MAX_REVIEW_COMMENT_BODY);
 assert.equal(input?.path, 'src/file.ts');
 assert.equal(findingCommentInput({...finding,path:undefined,line:undefined}, {projectId:'project',root:'/repo',text:''}), undefined);
});
