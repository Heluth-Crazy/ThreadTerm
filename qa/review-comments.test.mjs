import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-review-comments-'));
const output = join(scratch, 'review-comments.mjs');
await build({ entryPoints: [resolve('renderer/src/reviewComments.ts')], bundle: true, platform: 'node', format: 'esm', outfile: output });
const api = await import(pathToFileURL(output).href);
const { fileCommentPlace, fileCommentShortPlace, formatFileComments, MAX_FILE_COMMENTS, MAX_REVIEW_COMMENT_BODY, reviewExcerpt, sameCommentVersion } = api;
let activeStore, sequence = 0;
const prefix = 'threadterm.v3.file-comments:';
const parse = raw => { try {
    const value = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value : [];
}
catch {
    return [];
} };
const revisions = new WeakMap();
globalThis.window = { threadterm: { request: async (method, params) => {
            if (method === 'reviewDrafts.importLegacy')
                return { imported: false, complete: true };
            if (!activeStore)
                throw Error('review_comments_unavailable');
            let versions = revisions.get(activeStore);
            if (!versions) {
                versions = new Map();
                revisions.set(activeStore, versions);
            }
            const key = prefix + params.scopeProjectId + ':' + params.scopeRoot;
            if (method === 'reviewDrafts.list')
                return { drafts: parse(activeStore.getItem(key)).map((draft, index) => ({ draftId: draft.id ?? 'raw-' + index, draft, scopeProjectId: params.scopeProjectId, scopeRoot: params.scopeRoot, revision: versions.get(draft.id) ?? 1, updatedAt: 'now' })) };
            if ((versions.get(params.draftId) ?? 0) !== params.expectedRevision)
                return { status: 'conflict', draft: null };
            if (method === 'reviewDrafts.upsert') {
                const draft = { ...params.draft, createdAt: new Date(1700000000000 + sequence++).toISOString() }, all = parse(activeStore.getItem(key));
                all.push(draft);
                activeStore.setItem(key, JSON.stringify(all));
                versions.set(params.draftId, params.expectedRevision + 1);
                return { status: 'ok', draft: { draftId: params.draftId, draft, revision: params.expectedRevision + 1, updatedAt: 'now' } };
            }
            if (method === 'reviewDrafts.delete') {
                for (const [name, raw] of activeStore.map) {
                    const remaining = parse(raw).filter(item => item.id !== params.draftId);
                    if (remaining.length)
                        activeStore.setItem(name, JSON.stringify(remaining));
                    else
                        activeStore.removeItem(name);
                }
                versions.set(params.draftId, params.expectedRevision + 1);
                return { status: 'deleted', draftId: params.draftId, revision: params.expectedRevision + 1 };
            }
            throw Error(method);
        }, onEvent: () => () => { } } };
const addFileComment = async (input, store) => { activeStore = store; return api.addFileComment(input); };
const loadFileComments = async (scope, store) => { activeStore = store; return api.loadFileComments(scope); };
const removeFileComments = async (scope, ids, store) => { activeStore = store; return api.removeFileComments(scope, ids); };
const memory = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), map }; };
const store = memory();
const scope = { projectId: 'p1', root: 'D:/work/repo' }, other = { projectId: 'p1', root: 'D:/work/other' };
const file = { kind: 'file' }, checkpoint = { kind: 'checkpoint', sessionId: 's', checkpointId: 'a' }, later = { kind: 'checkpoint', sessionId: 's', checkpointId: 'a', toCheckpointId: 'b' }, unstaged = { kind: 'git', staged: false }, staged = { kind: 'git', staged: true }, commit = { kind: 'commit', commit: '123456789abcdef' };
const base = { ...scope, path: 'src/b.ts', version: file, side: 'new', startLine: 12, endLine: 14, text: '\n  export function foo(a: string) {\n  return a;\n' };
const one = (await addFileComment({ ...base, body: 'Keep the public signature unchanged.' }, store));
assert.deepEqual((await loadFileComments({ projectId: 'p1', root: '\\\\?\\D:\\work\\repo' }, store)), one, 'extended Windows root has the same folder key');
assert.deepEqual((await loadFileComments(other, store)), [], 'folders are isolated');
const otherComment = (await addFileComment({ ...base, ...other, path: 'src/other.ts', body: 'Keep this separate.' }, store));
assert.equal((await loadFileComments(other, store)).length, 1, 'the other folder has its own comment');
(await addFileComment({ ...scope, path: 'src/a.ts', version: checkpoint, side: 'old', startLine: 40, endLine: 40, text: 'return cache.get(key);', body: 'Why was this removed?\nIt handled the empty case.' }, store));
const all = (await addFileComment({ ...base, startLine: 30, endLine: 30, text: 'x', body: '  Rename this.  ' }, store));
assert.equal(all[2].body, 'Rename this.');
assert.equal(reviewExcerpt('a'.repeat(200)), `${'a'.repeat(160)} …`);
assert.equal(reviewExcerpt('\n\n'), '');
assert.equal(MAX_REVIEW_COMMENT_BODY, 4000);
assert.equal(MAX_FILE_COMMENTS, 200);
await assert.rejects(async () => (await addFileComment({ ...base, body: '   ' }, store)), /review_comment_empty/);
await assert.rejects(async () => (await addFileComment({ ...base, body: 'x'.repeat(4001) }, store)), /review_comment_too_long/);
await assert.rejects(async () => (await addFileComment({ ...base, body: 'x' }, undefined)), /review_comments_unavailable/);
const boundary = (await addFileComment({ ...base, body: 'x'.repeat(4000) }, store));
assert.equal(boundary.at(-1).body.length, 4000, 'the 4000-character boundary is accepted');
(await removeFileComments(scope, (await loadFileComments(scope, store)).map(item => item.id), store));
assert.equal((await loadFileComments(other, store)).length, 1, 'removing one folder does not affect the other');
for (let index = 0; index < MAX_FILE_COMMENTS; index++)
    (await addFileComment({ ...base, startLine: 1, endLine: 1, text: '', body: `n${index}` }, store));
await assert.rejects(async () => (await addFileComment({ ...base, startLine: 1, endLine: 1, text: '', body: 'one more' }, store)), /review_comments_full/);
assert.equal((await removeFileComments(scope, (await loadFileComments(scope, store)).map(item => item.id), store)).length, 0);
await assert.rejects(async () => (await removeFileComments(scope, [], undefined)), /review_comments_unavailable/);
(await removeFileComments(other, otherComment.map(item => item.id), store));
assert.equal(store.map.size, 0);
const damaged = memory(), storageKey = 'threadterm.v3.file-comments:p1:d:\\work\\repo', saved = one[0];
damaged.setItem(storageKey, JSON.stringify([saved, { ...saved, projectId: 'other' }, { ...saved, root: 'D:/elsewhere' }, { ...saved, path: 'src\\bad.ts' }, { ...saved, path: 'D:/bad.ts' }, { ...saved, path: '../bad.ts' }, { ...saved, version: { kind: 'git', staged: 'yes' } }, { ...saved, version: { kind: 'checkpoint', sessionId: '', checkpointId: 'a' } }, { ...saved, version: { kind: 'checkpoint', sessionId: 's', checkpointId: '' } }, { ...saved, version: { kind: 'checkpoint', sessionId: 's', checkpointId: 'a', toCheckpointId: '' } }, { ...saved, createdAt: 'not-a-date' }, { ...saved, endLine: 1 }, 'junk']));
assert.deepEqual((await loadFileComments(scope, damaged)).map(item => item.id), [saved.id], 'damaged and foreign entries are dropped');
damaged.setItem(storageKey, '{not json');
assert.deepEqual((await loadFileComments(scope, damaged)), []);
const roots = { fileRoot: 'D:/work/repo', sessionRoot: 'D:/work/repo' };
const place = (version, side, zh = false, path = 'src/file.ts', startLine = 3, endLine = 5) => fileCommentPlace({ path, version, side, startLine, endLine }, roots, zh);
const short = (version, side, zh = false) => fileCommentShortPlace({ path: 'src/file.ts', version, side, startLine: 3, endLine: 5 }, zh);
const cases = [
    [file, 'old', 'src/file.ts:3-5', 'src/file.ts:3-5'], [file, 'new', 'src/file.ts:3-5', 'src/file.ts:3-5'],
    [checkpoint, 'old', 'src/file.ts (at the checkpoint, lines 3-5)', 'src/file.ts（检查点版本，第 3-5 行）'], [checkpoint, 'new', 'src/file.ts:3-5', 'src/file.ts:3-5'],
    [later, 'old', 'src/file.ts (at the checkpoint, lines 3-5)', 'src/file.ts（检查点版本，第 3-5 行）'], [later, 'new', 'src/file.ts (at a later checkpoint, lines 3-5)', 'src/file.ts（较新的检查点，第 3-5 行）'],
    [unstaged, 'old', 'src/file.ts (before the uncommitted changes, lines 3-5)', 'src/file.ts（未提交改动之前，第 3-5 行）'], [unstaged, 'new', 'src/file.ts:3-5', 'src/file.ts:3-5'],
    [staged, 'old', 'src/file.ts (at HEAD, lines 3-5)', 'src/file.ts（HEAD 版本，第 3-5 行）'], [staged, 'new', 'src/file.ts (staged version, lines 3-5)', 'src/file.ts（暂存版本，第 3-5 行）'],
    [commit, 'old', 'src/file.ts (before commit 1234567, lines 3-5)', 'src/file.ts（提交 1234567 之前，第 3-5 行）'], [commit, 'new', 'src/file.ts (in commit 1234567, lines 3-5)', 'src/file.ts（提交 1234567 中，第 3-5 行）'],
];
for (const [version, side, english, chinese] of cases) {
    assert.equal(place(version, side), english);
    assert.equal(place(version, side, true), chinese);
    assert.equal(place(version, side, false, 'src/file.ts', 7, 7), english.replace('src/file.ts:3-5', 'src/file.ts:7').replace('lines 3-5', 'line 7'));
    assert.equal(place(version, side, true, 'src/file.ts', 7, 7), chinese.replace('src/file.ts:3-5', 'src/file.ts:7').replace('第 3-5 行', '第 7 行'));
}
assert.equal(place(file, 'new', false, 'my dir/file.ts', 7, 7), '"my dir/file.ts":7');
assert.equal(fileCommentPlace({ path: 'src/a.ts', version: file, side: 'new', startLine: 1, endLine: 1 }, { fileRoot: 'D:/repo', sessionRoot: 'D:/other' }, false), 'D:/repo/src/a.ts:1');
assert.equal(place(file, 'new', false, 'src/file.ts', 7, 7), 'src/file.ts:7');
const shortCases = [[file, 'old', 'file.ts:3-5', 'file.ts:3-5'], [file, 'new', 'file.ts:3-5', 'file.ts:3-5'], [checkpoint, 'old', 'file.ts:3-5 (checkpoint)', 'file.ts:3-5（检查点）'], [checkpoint, 'new', 'file.ts:3-5', 'file.ts:3-5'], [later, 'old', 'file.ts:3-5 (checkpoint)', 'file.ts:3-5（检查点）'], [later, 'new', 'file.ts:3-5 (later checkpoint)', 'file.ts:3-5（较新检查点）'], [unstaged, 'old', 'file.ts:3-5 (before uncommitted)', 'file.ts:3-5（未提交改动前）'], [unstaged, 'new', 'file.ts:3-5', 'file.ts:3-5'], [staged, 'old', 'file.ts:3-5 (HEAD)', 'file.ts:3-5（HEAD）'], [staged, 'new', 'file.ts:3-5 (staged)', 'file.ts:3-5（暂存）'], [commit, 'old', 'file.ts:3-5 (before 1234567)', 'file.ts:3-5（提交 1234567 之前）'], [commit, 'new', 'file.ts:3-5 (commit 1234567)', 'file.ts:3-5（提交 1234567）']];
for (const [version, side, english, chinese] of shortCases) {
    assert.equal(short(version, side), english);
    assert.equal(short(version, side, true), chinese);
}
assert.ok(sameCommentVersion(file, { kind: 'file' }));
assert.ok(sameCommentVersion(checkpoint, { ...checkpoint }));
assert.ok(sameCommentVersion(later, { ...later }));
assert.ok(sameCommentVersion(unstaged, { kind: 'git', staged: false }));
assert.ok(sameCommentVersion(commit, { ...commit }));
assert.ok(!sameCommentVersion(checkpoint, { ...checkpoint, sessionId: 'other' }));
assert.ok(!sameCommentVersion(checkpoint, { ...checkpoint, checkpointId: 'other' }));
assert.ok(!sameCommentVersion(later, { ...later, toCheckpointId: 'other' }));
assert.ok(!sameCommentVersion(unstaged, staged));
assert.ok(!sameCommentVersion(commit, { ...commit, commit: '123456789abcdee' }));
assert.ok(!sameCommentVersion(file, commit));
const formatted = [
    { ...base, id: '1', createdAt: '', excerpt: 'export function foo(a: string) {', body: 'Keep the public signature unchanged.' },
    { ...base, id: '2', createdAt: '', path: 'src/a.ts', version: checkpoint, side: 'old', startLine: 40, endLine: 40, excerpt: 'return cache.get(key);', body: 'Why was this removed?\nIt handled the empty case.' },
    { ...base, id: '3', createdAt: '', startLine: 30, endLine: 30, excerpt: 'x', body: 'Rename this.' },
];
assert.equal(formatFileComments(formatted, roots, false), ['Review comments:', '- src/b.ts:12-14 — Keep the public signature unchanged.', '  > export function foo(a: string) {', '- src/b.ts:30 — Rename this.', '  > x', '- src/a.ts (at the checkpoint, line 40) — Why was this removed?', '  It handled the empty case.', '  > return cache.get(key);'].join('\n'));
assert.equal(formatFileComments(formatted.slice(1, 2), roots, true), ['审查意见：', '- src/a.ts（检查点版本，第 40 行） — Why was this removed?', '  It handled the empty case.', '  > return cache.get(key);'].join('\n'));
assert.equal(formatFileComments([{ ...formatted[0], excerpt: '' }], roots, false), ['Review comments:', '- src/b.ts:12-14 — Keep the public signature unchanged.'].join('\n'));
console.log('review comments: ok');
