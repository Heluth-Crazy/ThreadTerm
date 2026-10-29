import assert from 'node:assert/strict';
import test from 'node:test';
import {
 branchScopeKey, compareBaseMovedText, compareBaseOptions, compareDiffEditable, compareEmptyText, compareGroups,
 compareHeaderText, compareOriginalPath, comparePaths, compareReloadText, compareStaleText, compareStatusLetter,
 compareStatusLabel, compareTabSignature, compareTotals, compareUnavailableText, forgetBranchScopePreferences,
 readBranchScopePreference, sameDiffTabKey, writeBranchScopePreference,
} from './branchScope';

const file = (path:string, status:'added'|'modified'|'deleted'|'renamed'|'typechange' = 'modified', additions = 1, deletions = 0) =>
 ({path, status, additions, deletions, binary:false, ...(status === 'renamed' ? {originalPath:`old/${path}`} : {})});

test('branch scope header, totals and empty states are bilingual', () => {
 const files = [file('src/a.ts', 'modified', 300, 80), file('src/b.ts', 'added', 40, 7)];
 assert.deepEqual(compareTotals(files), {additions:340, deletions:87});
 assert.equal(compareHeaderText({branch:'feature-x', base:'origin/main', files, zh:false}), 'feature-x vs origin/main · 2 files · +340 −87');
 assert.equal(compareHeaderText({branch:'feature-x', base:'origin/main', files, zh:true}), 'feature-x 对比 origin/main · 2 个文件 · +340 −87');
 assert.equal(compareHeaderText({branch:'feature-x', base:'origin/main', files:[files[0]], zh:false}), 'feature-x vs origin/main · 1 file · +300 −80');
 assert.equal(compareHeaderText({branch:'feature-x', base:'origin/main', files, truncated:true, zh:false}), 'feature-x vs origin/main · 2+ files · +340 −87');
 assert.equal(compareEmptyText('origin/main', false), 'No changes compared to origin/main.');
 assert.equal(compareEmptyText('origin/main', true), '与 origin/main 相比没有更改。');
 assert.equal(compareUnavailableText(false), 'No base branch could be determined. Choose a base branch above.');
 assert.equal(compareStaleText(false), 'The base branch changed, so this diff could not be shown.');
 assert.equal(compareReloadText(false), 'Reload against the current base');
 assert.equal(compareReloadText(true), '按当前基准重新载入');
 assert.equal(compareBaseMovedText(false), 'Base updated — refresh');
 assert.equal(compareBaseMovedText(true), '基准已更新，请刷新');
});

test('files group by directory and navigation follows the displayed order', () => {
 const files = [file('src/workbench/z.ts'), file('README.md'), file('src/a.ts'), file('src/workbench/a.ts')];
 assert.deepEqual(compareGroups(files).map(group => [group.dir, group.files.map(entry => entry.path)]), [
  ['', ['README.md']],
  ['src', ['src/a.ts']],
  ['src/workbench', ['src/workbench/a.ts', 'src/workbench/z.ts']],
 ]);
 assert.deepEqual(compareGroups([]), []);
 // Navigation and roving use the displayed grouping, never a plain path sort.
 const mixed = [file('src/a.ts'), file('tsconfig.json'), file('package.json'), file('README.md')];
 assert.deepEqual(compareGroups(mixed).flatMap(group => group.files.map(entry => entry.path)), ['README.md', 'package.json', 'tsconfig.json', 'src/a.ts']);
 assert.deepEqual(comparePaths(mixed), ['README.md', 'package.json', 'tsconfig.json', 'src/a.ts']);
 for(const list of [[], [file('only.txt')], files, mixed]) {
  assert.deepEqual(comparePaths(list), compareGroups(list).flatMap(group => group.files.map(entry => entry.path)));
 }
});

test('status letters, labels and editability match the diff surface', () => {
 assert.deepEqual(['added','modified','deleted','renamed','typechange'].map(status => compareStatusLetter(status as never)), ['A','M','D','R','T']);
 assert.equal(compareStatusLabel('renamed', false), 'Renamed');
 assert.equal(compareStatusLabel('renamed', true), '重命名');
 assert.equal(compareDiffEditable({}, true), true);
 assert.equal(compareDiffEditable({committedOnly:true}, true), false);
 assert.equal(compareDiffEditable({}, false), false, 'a file that is gone from disk has no editable side');
});

test('the base picker keeps the default first, then locals, then remotes', () => {
 const branches = [
  {name:'main', remote:false, current:false},
  {name:'feature', remote:false, current:true},
  {name:'origin/main', remote:true, current:false},
 ];
 assert.deepEqual(compareBaseOptions(branches, {current:'feature', defaultRef:'origin/main', zh:false}), [
  {ref:'origin/main', label:'origin/main (default)', kind:'default'},
  {ref:'main', label:'main', kind:'local'},
 ]);
 assert.deepEqual(compareBaseOptions(branches, {current:'feature', defaultRef:'origin/main', zh:true})[0].label, 'origin/main（默认）');
 assert.deepEqual(compareBaseOptions([], {zh:false}), []);
 assert.deepEqual(compareBaseOptions(branches, {current:'main', defaultRef:'main', zh:false}).map(option => option.ref), ['main', 'origin/main']);
});

test('a compare tab is deduped on its base, merge base, own original path and scope', () => {
 const compare = {base:'origin/main', oid:'a'.repeat(40), mergeBase:'b'.repeat(40)};
 assert.equal(sameDiffTabKey(undefined, {staged:false, compare}), false);
 assert.equal(sameDiffTabKey({staged:false, compare}, {staged:false, compare}), true);
 assert.equal(sameDiffTabKey({compare}, {staged:false, compare}), true);
 // Toggling "Committed only" must not reuse the working-tree tab: it shows other content and is read-only.
 assert.equal(sameDiffTabKey({compare}, {compare:{...compare, committedOnly:true}}), false);
 assert.equal(sameDiffTabKey({compare:{...compare, committedOnly:true}}, {compare:{...compare, committedOnly:true}}), true);
 // A rename's base path is part of the identity as well.
 assert.equal(sameDiffTabKey({compare:{...compare, originalPath:'old.txt'}}, {compare}), false);
 assert.equal(sameDiffTabKey({compare}, {compare:{...compare, originalPath:'old.txt'}}), false);
 // Staged and index diffs keep their own distinction, and a compare tab is never an index diff.
 assert.equal(sameDiffTabKey({staged:true}, {staged:false}), false);
 assert.equal(sameDiffTabKey({staged:false}, {compare}), false);
 assert.equal(compareTabSignature(undefined), '');
 assert.notEqual(compareTabSignature(compare), compareTabSignature({...compare, mergeBase:'c'.repeat(40)}));
});

test('a retargeted compare diff resolves the base path per file, never from the tab origin', () => {
 const files = [
  {path:'README.md'},
  {path:'renamed.txt', originalPath:'original.txt'},
  {path:'src/a.ts'},
 ];
 // The tab was opened on renamed.txt, so its own originalPath applies to that path only.
 const compare = {originalPath:'original.txt'};
 assert.equal(compareOriginalPath('renamed.txt', 'renamed.txt', compare, files), 'original.txt');
 assert.equal(compareOriginalPath('renamed.txt', 'renamed.txt', compare, undefined), 'original.txt');
 // After Alt+→ the tab path is src/a.ts: no unrelated file may inherit original.txt.
 assert.equal(compareOriginalPath('src/a.ts', 'src/a.ts', compare, files), undefined);
 assert.equal(compareOriginalPath('src/a.ts', 'renamed.txt', compare, undefined), undefined);
 assert.equal(compareOriginalPath('README.md', 'renamed.txt', undefined, files), undefined);
 // The list always wins when it knows the path.
 assert.equal(compareOriginalPath('renamed.txt', undefined, undefined, files), 'original.txt');
});

test('the scope choice is remembered per worktree in memory only', () => {
 forgetBranchScopePreferences();
 const key = branchScopeKey({projectId:'p1', worktreePath:'D:\\repo\\wt'});
 assert.equal(readBranchScopePreference(key), undefined);
 writeBranchScopePreference(key, {mode:'branch', base:'origin/main', committedOnly:true});
 assert.deepEqual(readBranchScopePreference(key), {mode:'branch', base:'origin/main', committedOnly:true});
 assert.notEqual(branchScopeKey({projectId:'p1'}), key, 'the default worktree is a different scope');
 assert.equal(readBranchScopePreference(branchScopeKey({projectId:'p1'})), undefined);
 writeBranchScopePreference(key, {mode:'changes', committedOnly:false});
 assert.deepEqual(readBranchScopePreference(key), {mode:'changes', committedOnly:false});
 forgetBranchScopePreferences();
 assert.equal(readBranchScopePreference(key), undefined);
});
