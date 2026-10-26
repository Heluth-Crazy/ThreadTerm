import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qaOpenExternalPathsOverride } from './externalFiles.js';

test('the external-file QA override accepts only an unpackaged JSON path array', () => {
  const paths = [join(tmpdir(), 'external-files', 'one.txt'), join(tmpdir(), 'external-files', 'two.txt')];
  assert.deepEqual(qaOpenExternalPathsOverride(JSON.stringify(paths), false), paths);
  assert.equal(qaOpenExternalPathsOverride(JSON.stringify(paths), true), undefined);
  assert.equal(qaOpenExternalPathsOverride(undefined, false), undefined);
  assert.deepEqual(qaOpenExternalPathsOverride(JSON.stringify({ path: paths[0] }), false), []);
  assert.deepEqual(qaOpenExternalPathsOverride(JSON.stringify([paths[0], 4]), false), []);
  assert.deepEqual(qaOpenExternalPathsOverride('not JSON', false), []);
});
