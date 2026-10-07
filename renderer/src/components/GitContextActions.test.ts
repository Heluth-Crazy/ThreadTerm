import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unifiedGitDiff } from './GitContextActions';

test('unifiedGitDiff retains only the changed GitDiff hunks', () => {
 const diff = unifiedGitDiff('src/cart.ts', 'before\nkeep\nafter\n', 'before\nchanged\nafter\n');
 assert.match(diff, /^diff --git a\/src\/cart\.ts b\/src\/cart\.ts\n--- a\/src\/cart\.ts\n\+\+\+ b\/src\/cart\.ts/m);
 assert.match(diff, /^@@ -2 \+2 @@$/m);
 assert.match(diff, /^-keep$/m);
 assert.match(diff, /^\+changed$/m);
 assert.doesNotMatch(diff, /^ before$/m);
 assert.doesNotMatch(diff, /^ after$/m);
});

test('unifiedGitDiff uses the preceding line for empty insertion and deletion ranges', () => {
 const first = unifiedGitDiff('src/cart.ts', 'after\n', 'before\nafter\n');
 const middle = unifiedGitDiff('src/cart.ts', 'before\nafter\n', 'before\ninserted\nafter\n');
 const deletion = unifiedGitDiff('src/cart.ts', 'before\nafter\n', 'after\n');
 assert.match(first, /^@@ -0,0 \+1 @@$/m);
 assert.match(middle, /^@@ -1,0 \+2 @@$/m);
 assert.match(deletion, /^@@ -1 \+0,0 @@$/m);
 assert.match(middle, /^\+inserted$/m);
});

test('unifiedGitDiff marks changed final lines that lack a trailing newline and keeps separate hunks', () => {
 const finalLine = unifiedGitDiff('src/cart.ts', 'before', 'after');
 const multi = unifiedGitDiff('src/cart.ts', 'one\ntwo\nthree\nfour\n', 'one\nTWO\nthree\nFOUR\n');
 assert.match(finalLine, /-before\n\\ No newline at end of file\n\+after\n\\ No newline at end of file$/m);
 assert.match(multi, /^@@ -2 \+2 @@$/m);
 assert.match(multi, /^@@ -4 \+4 @@$/m);
 assert.match(multi, /^-two$/m);
 assert.match(multi, /^\+FOUR$/m);
});
