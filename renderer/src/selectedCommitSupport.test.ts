import assert from 'node:assert/strict';
import test from 'node:test';
import { selectedCommitUnsupportedText } from './workbench/selectedCommitSupport';

test('selected commit capability reasons explain the prerequisite and recovery in both languages', () => {
 const cases = [
  ['git_unavailable', /Install Git/, /安装 Git/],
  ['git_capability_probe_failed', /Check that Git/, /检查 Git/],
  ['git_hook_run_unavailable', /Git 2\.36 or newer/, /Git 2\.36 或更新版本/],
  ['git_ref_transaction_unavailable', /reference transactions/, /引用事务/],
 ] as const;
 for(const [code,en,zh] of cases) {
  assert.match(selectedCommitUnsupportedText(code,false),en);
  assert.match(selectedCommitUnsupportedText(code,true),zh);
  assert.match(selectedCommitUnsupportedText(code,false),/restart ThreadTerm/);
  assert.match(selectedCommitUnsupportedText(code,true),/重启 ThreadTerm/);
  assert.ok(!selectedCommitUnsupportedText(code,false).includes(code));
 }
});

test('unknown reasons have a generic recovery sentence while the caller retains the diagnostic code', () => {
 for(const zh of [false,true]) {
  const text=selectedCommitUnsupportedText('future_git_capability',zh);
  assert.equal(text,selectedCommitUnsupportedText(undefined,zh));
  assert.ok(!text.includes('future_git_capability'));
  assert.match(text,zh ? /重启 ThreadTerm/ : /restart ThreadTerm/);
 }
});
