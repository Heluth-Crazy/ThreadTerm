import assert from 'node:assert/strict';
import test from 'node:test';
import { workbenchError } from './workbench/errors';

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
