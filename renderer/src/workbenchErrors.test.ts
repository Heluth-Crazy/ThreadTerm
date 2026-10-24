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
