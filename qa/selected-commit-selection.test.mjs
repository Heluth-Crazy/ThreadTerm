import assert from 'node:assert/strict';
import test from 'node:test';
import { clearSelectedChanges, selectedChanges, selectedCommitKey, setGroupSelection, toggleSelectedChange } from '../renderer/src/workbench/selectedCommitSelection.ts';
import {workbenchError} from '../renderer/src/workbench/errors.ts';

const dual = {path:'src/dual.ts',indexStatus:'M',worktreeStatus:'M',untracked:false};
const stagedOnly = {path:'src/staged.ts',indexStatus:'A',worktreeStatus:' ',untracked:false};

test('selected commit failures preserve Git details through the Electron error wrapper',()=>{
 const error=new Error("Error invoking remote method 'threadterm:request': RuntimeRequestError: git_selected_commit_hook_failed: pre-commit exited 1: lint rejected");
 assert.match(workbenchError(error,false),/no commit was created.*pre-commit exited 1: lint rejected/);
 assert.match(workbenchError(error,true),/未创建提交.*pre-commit exited 1: lint rejected/);
 assert.match(workbenchError(new Error('git_failed: fatal: missing author identity'),false),/fatal: missing author identity/);
});

test('selected commit state separates roots and the staged half of a dual-status row', () => {
 let selection = new Set();
 selection = toggleSelectedChange(selection, 'C:/one', 'staged', dual.path);
 selection = toggleSelectedChange(selection, 'C:/one', 'changes', dual.path);
 selection = toggleSelectedChange(selection, 'C:/two', 'staged', dual.path);
 assert.deepEqual(selectedChanges(selection, 'C:/one', 'staged', [dual]), [dual]);
 assert.deepEqual(selectedChanges(selection, 'C:/one', 'changes', [dual]), [dual]);
 assert.deepEqual(selectedChanges(selection, 'C:/two', 'staged', [dual]), [dual]);
 selection = clearSelectedChanges(selection, 'C:/one', 'staged', [dual]);
 assert.equal(selection.has(selectedCommitKey('C:/one', 'staged', dual.path)), false);
 assert.equal(selection.has(selectedCommitKey('C:/one', 'changes', dual.path)), true);
 assert.equal(selection.has(selectedCommitKey('C:/two', 'staged', dual.path)), true);
});

test('group selection clears only matching completed file choices', () => {
 let selection = setGroupSelection(new Set(), 'C:/root', 'staged', [dual, stagedOnly], true);
 selection = clearSelectedChanges(selection, 'C:/root', 'staged', [dual]);
 assert.deepEqual(selectedChanges(selection, 'C:/root', 'staged', [dual, stagedOnly]), [stagedOnly]);
});
