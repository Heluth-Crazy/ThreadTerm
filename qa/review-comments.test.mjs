import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-review-comments-'));
const output = join(scratch, 'review-comments.mjs');
await build({ entryPoints: [resolve('renderer/src/reviewComments.ts')], bundle: true, platform: 'node', format: 'esm', outfile: output });
const { addReviewComment, formatReviewComments, loadReviewComments, MAX_REVIEW_COMMENTS, removeReviewComments, reviewCommentPlace, reviewCommentShortPlace, reviewExcerpt } = await import(pathToFileURL(output).href);

const memory = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), map }; };
const store = memory();
const base = { sessionId: 's1', checkpointId: 'c1', current: true };

// Two files, both sides; the order of files is the order they were first commented on.
addReviewComment({ ...base, path: 'src/b.ts', side: 'new', startLine: 12, endLine: 14, text: '\n  export function foo(a: string) {\n  return a;\n', body: 'Keep the public signature unchanged.' }, store);
addReviewComment({ ...base, path: 'src/a.ts', side: 'old', startLine: 40, endLine: 40, text: 'return cache.get(key);', body: 'Why was this removed?\nIt handled the empty case.' }, store);
const list = addReviewComment({ ...base, path: 'src/b.ts', side: 'new', startLine: 30, endLine: 30, text: 'x', body: '  Rename this.  ' }, store);
assert.equal(list.length, 3);
assert.equal(list[2].body, 'Rename this.', 'bodies are trimmed');
assert.deepEqual(loadReviewComments('s1', store), list, 'stored per session');
assert.deepEqual(loadReviewComments('s2', store), [], 'other sessions see none');

assert.equal(formatReviewComments(list, false), [
  'Review comments on your changes:',
  '- src/b.ts:12-14 — Keep the public signature unchanged.',
  '  > export function foo(a: string) { …',
  '- src/b.ts:30 — Rename this.',
  '  > x',
  '- src/a.ts (before your change, line 40) — Why was this removed?',
  '  It handled the empty case.',
  '  > return cache.get(key);',
].join('\n'));
assert.equal(formatReviewComments(list.slice(1, 2), true), ['对你的改动的审查意见：', '- src/a.ts（改动前，第 40 行） — Why was this removed?', '  It handled the empty case.', '  > return cache.get(key);'].join('\n'));

// Lines of a later checkpoint are not lines of the current file; paths with spaces are quoted like Send to agent.
assert.equal(reviewCommentPlace({ path: 'docs/my file.md', side: 'new', current: false, startLine: 3, endLine: 5 }, false), '"docs/my file.md" (at a later checkpoint, lines 3-5)');
assert.equal(reviewCommentPlace({ path: 'a.ts', side: 'new', current: false, startLine: 3, endLine: 3 }, true), 'a.ts（较新的检查点，第 3 行）');
assert.equal(reviewCommentShortPlace({ path: 'src/cart.ts', side: 'old', current: true, startLine: 2, endLine: 4 }, false), 'cart.ts:2-4 (before)');
assert.equal(reviewCommentShortPlace({ path: 'src/cart.ts', side: 'new', current: true, startLine: 2, endLine: 2 }, true), 'cart.ts:2');
assert.equal(reviewCommentShortPlace({ path: 'cart.ts', side: 'new', current: false, startLine: 3, endLine: 3 }, true), 'cart.ts:3（较新检查点）');
assert.equal(reviewExcerpt('a'.repeat(200)), `${'a'.repeat(160)} …`);
assert.equal(reviewExcerpt('\n\n'), '');

// Removing keeps the rest; removing everything clears the stored entry.
assert.deepEqual(removeReviewComments('s1', [list[0].id], store).map(item => item.path), ['src/a.ts', 'src/b.ts']);
removeReviewComments('s1', list.map(item => item.id), store);
assert.equal(store.map.size, 0);

// Limits and validation.
assert.throws(() => addReviewComment({ ...base, path: 'a', side: 'new', startLine: 1, endLine: 1, text: '', body: '   ' }, store), /review_comment_empty/);
assert.throws(() => addReviewComment({ ...base, path: 'a', side: 'new', startLine: 1, endLine: 1, text: '', body: 'x'.repeat(4001) }, store), /review_comment_too_long/);
for (let index = 0; index < MAX_REVIEW_COMMENTS; index++) addReviewComment({ ...base, path: 'a', side: 'new', startLine: 1, endLine: 1, text: '', body: `n${index}` }, store);
assert.throws(() => addReviewComment({ ...base, path: 'a', side: 'new', startLine: 1, endLine: 1, text: '', body: 'one more' }, store), /review_comments_full/);

// Damaged or foreign stored entries are dropped, never shown half-valid.
const damaged = memory();
damaged.setItem('threadterm.v3.review-comments.s1', JSON.stringify([{ ...list[0] }, { ...list[1], sessionId: 'other' }, { ...list[2], endLine: 1 }, { ...list[2], checkpointId: '' }, 'junk']));
assert.deepEqual(loadReviewComments('s1', damaged).map(item => item.id), [list[0].id]);
damaged.setItem('threadterm.v3.review-comments.s1', '{not json');
assert.deepEqual(loadReviewComments('s1', damaged), []);
console.log('review comments: ok');
