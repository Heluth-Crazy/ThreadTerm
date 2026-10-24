import test from 'node:test';
import assert from 'node:assert/strict';
import { groupDropFilePaths } from './groupFileDrop';

test('native Group file drops keep usable paths and ignore unavailable files', () => {
 const first = {} as File, missing = {} as File, broken = {} as File;
 assert.deepEqual(groupDropFilePaths([first, missing, broken], file => {
  if (file === first) return 'group/page.html';
  if (file === broken) throw new Error('not backed by disk');
  return '';
 }), ['group/page.html']);
 assert.deepEqual(groupDropFilePaths([first]), []);
});
