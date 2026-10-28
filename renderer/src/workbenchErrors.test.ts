import assert from 'node:assert/strict';
import test from 'node:test';
import { workbenchError } from './workbench/errors';

test('merge and divergent pull outcomes have bilingual explanations',()=>{
 for(const code of ['pull_diverged','no_upstream','git_merge_failed','merge_incomplete','merge_interrupted','merge_completed_after_error']) for(const zh of [true,false]) {
  const message=workbenchError(new Error(code),zh);
  assert.notEqual(message,code);
  assert.match(message,zh?/[\u4e00-\u9fff]/:/[a-z]/i);
 }
 assert.equal(workbenchError(new Error('merge_interrupted: git_timeout'),false),'The merge was interrupted before Git recorded it, so your working tree may contain partial merge changes. Review them in Source Control before committing; to retry, discard those changes and run the merge again.');
 assert.equal(workbenchError(new Error('merge_interrupted: git_timeout'),true),'合并在 Git 记录之前被中断，工作区可能包含部分合并结果。提交前请在源代码管理中检查这些更改；如需重试，请先丢弃这些更改再重新合并。');
 assert.match(workbenchError(new Error('git_merge_failed: hook refused'),false),/hook refused/);
});

test('an unavailable checkpoint is explained without hiding the detail', () => {
 const error = new Error('checkpoint_unavailable: git_failed: fatal: Not a valid object name');
 assert.match(workbenchError(error, false), /^The checkpoint objects are missing or their store is unavailable/);
 assert.match(workbenchError(error, false), /Not a valid object name/);
 assert.match(workbenchError(error, true), /^检查点对象已丢失或存储不可用/);
});

test('a verified-absent baseline is not reported as an unavailable checkpoint', () => {
 assert.equal(workbenchError(new Error('checkpoint_missing'), false), 'The checkpoint no longer exists.');
 assert.equal(workbenchError(new Error('file_conflict'), true), '文件已在磁盘上被修改，请刷新后重试。');
});

test('discard conflicts use the dedicated retry message without changing diff conflict text', () => {
 assert.equal(workbenchError(new Error('file_conflict: changed'), false, 'discard'), 'Files changed since you opened this dialog. Nothing was discarded. Review the changes and try again.');
 assert.equal(workbenchError(new Error('index_conflict'), true, 'discard'), '自打开此对话框后文件已发生更改。未丢弃任何更改。请检查更改后重试。');
 assert.equal(workbenchError(new Error('index_conflict'), false), 'The index changed since this diff was shown. Refresh and try again.');
 assert.equal(workbenchError(new Error('discard_incomplete: recycled changed.ts; file_conflict'), false, 'discard'), 'Some changes were discarded before an error stopped the operation. The list has been refreshed; check what remains. recycled changed.ts; file_conflict');
 assert.equal(workbenchError(new Error('discard_incomplete'), true, 'discard'), '操作因错误中止前已丢弃部分更改。列表已刷新，请检查剩余内容。');
 assert.equal(workbenchError(new Error('discard_incomplete: recycled changed.ts; Unsupported runtime method'), false, 'discard'), 'Some changes were discarded before an error stopped the operation. The list has been refreshed; check what remains. recycled changed.ts; Unsupported runtime method');
});

test('fingerprint rejects non-file targets with a readable error', () => {
 assert.equal(workbenchError(new Error('invalid_file_type'), false), 'The target is not a regular file and cannot be used for this operation.');
 assert.equal(workbenchError(new Error('invalid_file_type'), true), '目标不是普通文件，无法执行此操作。');
});

test('worktree base errors explain how to recover', () => {
 assert.equal(workbenchError(new Error('start_point_not_found'), false), 'The selected base commit or branch could not be found. Refresh branches and try again.');
 assert.equal(workbenchError(new Error('start_point_not_found'), true), '找不到所选基准提交或分支。请刷新分支后重试。');
 assert.equal(workbenchError(new Error('invalid_request'), false), 'The request is invalid. Check the worktree options and try again.');
});
