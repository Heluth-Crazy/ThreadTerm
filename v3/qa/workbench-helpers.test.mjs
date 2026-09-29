import assert from 'node:assert/strict';
import test from 'node:test';
import { fuzzyFilter, fuzzyScore, splitQuickOpenQuery } from '../renderer/src/workbench/fuzzy.ts';
import { changeGroups, decorationFor, decorationIndex } from '../renderer/src/workbench/gitDecorations.ts';
import { stageChunk, unstageChunk, withLineBreaks } from '../renderer/src/workbench/indexEdit.ts';
import { formatAgentReference, insertAtCaret, referencePath } from '../renderer/src/workbench/agentReference.ts';
import { workbenchError } from '../renderer/src/workbench/errors.ts';

test('quick open prefers file-name matches, contiguous runs and shallow paths', () => {
 const paths = ['src/components/FileWorkspace.tsx', 'src/workbench/fuzzy.ts', 'node_modules/pkg/lib/fuzzy.ts', 'docs/fw-notes.md', 'src/components/Framework.tsx'];
 const ranked = fuzzyFilter(paths, 'fw').map(match => match.path);
 assert.equal(ranked[0], 'docs/fw-notes.md', 'contiguous start-of-name match wins');
 assert.ok(ranked.includes('src/components/FileWorkspace.tsx'));
 assert.deepEqual(fuzzyFilter(paths, 'fuzzy').map(match => match.path).slice(0, 2), ['src/workbench/fuzzy.ts', 'node_modules/pkg/lib/fuzzy.ts']);
 assert.equal(fuzzyScore('src/app.ts', 'xyz'), undefined);
 assert.deepEqual(fuzzyScore('src/app.ts', 'app').positions, [4, 5, 6], 'positions point into the file name');
 assert.deepEqual(splitQuickOpenQuery('src/app.ts:12:4'), {query:'src/app.ts', line:12, column:4});
 assert.deepEqual(splitQuickOpenQuery('app:30'), {query:'app', line:30, column:undefined});
 assert.deepEqual(splitQuickOpenQuery('C:notes'), {query:'C:notes'}, 'a colon without digits is part of the query');
});

test('porcelain status maps to Source Control groups and roll-up decorations', () => {
 const change = (path, indexStatus, worktreeStatus, untracked = false) => ({path, indexStatus, worktreeStatus, untracked});
 assert.deepEqual(changeGroups(change('a', 'M', 'M')), ['staged', 'changes']);
 assert.deepEqual(changeGroups(change('b', '?', '?', true)), ['untracked']);
 assert.deepEqual(changeGroups(change('c', 'U', 'U')), ['conflicts']);
 assert.deepEqual(changeGroups(change('d', 'A', ' ')), ['staged']);
 assert.deepEqual(decorationFor(change('e', 'R', 'M'), 'staged'), {letter:'R', tone:'renamed'});
 assert.deepEqual(decorationFor(change('f', ' ', 'D'), 'changes'), {letter:'D', tone:'deleted'});
 const index = decorationIndex([change('src/a/x.ts', ' ', 'M'), change('src/b.ts', ' ', 'D'), change('src/a/new.ts', '?', '?', true)]);
 assert.equal(index.files.get('src/a/new.ts').letter, 'U');
 assert.equal(index.folders.get('src'), 'deleted', 'a folder shows its most severe descendant');
 assert.equal(index.folders.get('src/a'), 'modified');
});

test('hunk staging swaps exactly one chunk and keeps the index line breaks', () => {
 // a = index, b = working file; @codemirror/merge line chunks (to points past the line break).
 const index = 'one\ntwo\nthree\n', working = 'one\nTWO\nthree\nfour\n';
 const second = {fromA:4, toA:8, fromB:4, toB:8};
 assert.equal(stageChunk(index, working, second), 'one\nTWO\nthree\n');
 const appended = {fromA:14, toA:14, fromB:14, toB:19};
 assert.equal(stageChunk(index, working, appended), 'one\ntwo\nthree\nfour\n');
 // Staged view: a = HEAD, b = index; unstage restores HEAD for that chunk only.
 assert.equal(unstageChunk('one\ntwo\n', 'one\n2\n', {fromA:4, toA:8, fromB:4, toB:6}), 'one\ntwo\n');
 // A chunk at the very end of a document without a trailing newline (to = length + 1).
 assert.equal(stageChunk('a\nb', 'a\nB', {fromA:2, toA:4, fromB:2, toB:4}), 'a\nB');
 assert.equal(withLineBreaks('a\nb\n', 'x\r\ny\r\n'), 'a\r\nb\r\n');
 assert.equal(withLineBreaks('a\nb\n', 'x\ny\n'), 'a\nb\n');
 assert.equal(withLineBreaks('a\nb\n', ''), 'a\nb\n', 'an empty index keeps LF (Git normalises on add)');
});

test('agent references are one line, quoted when needed and relative only within the same root', () => {
 assert.equal(formatAgentReference({path:'src/app.ts', startLine:10, endLine:24}), 'src/app.ts:10-24');
 assert.equal(formatAgentReference({path:'src/app.ts', startLine:7, endLine:7}), 'src/app.ts:7');
 assert.equal(formatAgentReference({path:'my dir\\a.ts'}), '"my dir/a.ts"');
 assert.equal(referencePath('src/a.ts', 'D:\\repo', 'd:/repo/'), 'src/a.ts');
 assert.equal(referencePath('src/a.ts', 'D:\\repo', 'D:\\other'), 'D:\\repo\\src\\a.ts');
 assert.deepEqual(insertAtCaret('fix this', 8, 'src/a.ts:3'), {text:'fix this src/a.ts:3 ', caret:20});
 assert.deepEqual(insertAtCaret('see  please', 4, 'x.ts'), {text:'see x.ts please', caret:8});
 assert.ok(!/\n/.test(formatAgentReference({path:'a.ts', startLine:1, endLine:9})));
});

test('runtime errors map to readable text without hiding Git output', () => {
 assert.match(workbenchError(new Error("Error invoking remote method 'threadterm:request': Error: file_exists"), false), /already exists/);
 assert.match(workbenchError(new Error('Unsupported runtime method'), true), /重启/);
 assert.equal(workbenchError(new Error('git_failed: fatal: not a git repository'), false), 'fatal: not a git repository');
 assert.equal(workbenchError(new Error('something unexpected'), false), 'something unexpected');
});
