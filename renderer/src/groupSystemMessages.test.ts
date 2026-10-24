import assert from 'node:assert/strict';
import test from 'node:test';
import { groupReadOnlyNote, groupSystemMessage } from './groupMessages';

test('localizes structured read-only file-change system rows at render time', () => {
 const body = JSON.stringify({ kind: 'read_only_files_changed', paths: ['review/notes.md'] });
 assert.match(groupSystemMessage(body, false), /Files changed during a read-only member's turn: review\/notes\.md/);
 assert.match(groupSystemMessage(body, true), /只读成员处理期间文件已更改：review\/notes\.md/);
});

test('keeps historical system prose intact', () => {
 assert.equal(groupSystemMessage('Existing group notice.', true), 'Existing group notice.');
 assert.equal(groupSystemMessage('{not JSON', true), '{not JSON');
});

test('localizes known read-only notes and preserves unknown diagnostics', () => {
 assert.equal(groupReadOnlyNote('The group member reports the requested native read-only mode', true), '群聊成员已确认启用请求的原生只读模式。');
 assert.match(groupReadOnlyNote('provider diagnostic', true) ?? '', /provider diagnostic/);
});
