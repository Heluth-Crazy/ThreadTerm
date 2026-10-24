import test from 'node:test';
import assert from 'node:assert/strict';
import { clearGroupWarning, groupAttachEscape, groupAttachWarning, groupDropWarning, groupIssueText, groupIssueTitle, groupReferenceTitle } from './groupMessages';

test('warnings raised in Chinese render in English after a locale switch', () => {
 const issue = groupAttachWarning;
 assert.equal(groupIssueText(issue, true), '请选择群聊目录内的路径或 HTTP(S) 网址。');
 assert.equal(groupIssueText(issue, false), 'Choose a path inside the group folder or an HTTP(S) URL.');
});
test('runtime failures have bilingual explanations and preserve diagnostic codes', () => {
 const known = { code: 'group_delivery_not_retryable' };
 assert.equal(groupIssueTitle(known), known.code);
 assert.match(groupIssueText(known, false), /cannot be resent/);
 assert.match(groupIssueText(known, true), /无法重新发送/);
 for (const zh of [false, true]) assert.match(groupIssueText({ code: 'future_failure' }, zh), /future_failure/);
 assert.match(groupIssueText({ code: 'future_failure' }, true), /无法完成群聊操作/);
 assert.match(groupIssueText({ code: '__proto__' }, false), /__proto__/);
});
test('attach warnings clear on edit, close, include, dismissal and successful send', () => {
 for (const event of ['attach-edit', 'attach-close', 'include', 'dismiss', 'send'] as const) assert.equal(clearGroupWarning(groupAttachWarning, event), undefined);
 assert.equal(clearGroupWarning(groupAttachWarning, 'edit'), groupAttachWarning);
});
test('drop warnings clear on next drop or message edit without clearing unrelated warnings', () => {
 for (const event of ['drop', 'edit', 'attach-edit', 'include', 'dismiss', 'send'] as const) assert.equal(clearGroupWarning(groupDropWarning, event), undefined);
 assert.equal(clearGroupWarning(groupDropWarning, 'attach-close'), groupDropWarning);
});
test('Escape closes attachment entry without interrupting IME composition', () => {
 assert.equal(groupAttachEscape({ key: 'Escape' }), true);
 assert.equal(groupAttachEscape({ key: 'Enter' }), false);
 assert.equal(groupAttachEscape({ key: 'Escape', isComposing: true }), false);
 assert.equal(groupAttachEscape({ key: 'Escape', keyCode: 229 }), false);
});
test('reference tooltips translate labels while preserving referenced user content', () => {
 const messages = [{ id: 'user', author: 'user' as const, body: 'Design my page', createdAt: '' }, { id: 'reply', author: 'member' as const, body: 'Done', handle: 'designer', replyTo: 'user', createdAt: '' }];
 assert.equal(groupReferenceTitle({ kind: 'reply', messageId: 'reply' }, messages, true), '@designer 的回复（回复：“Design my page”）');
 assert.equal(groupReferenceTitle({ kind: 'reply', messageId: 'reply' }, messages, false), '@designer\'s reply (to: "Design my page")');
 assert.equal(groupReferenceTitle({ kind: 'file', path: 'index.html' }, [], true), '文件 index.html');
 assert.equal(groupReferenceTitle({ kind: 'reply', title: '@designer\'s reply (to: "Earlier topic")' }, [], true), '@designer 的回复（回复：“Earlier topic”）');
});
