import assert from 'node:assert/strict';
import test from 'node:test';
import { workbenchError } from './workbench/errors';

test('merge and divergent pull outcomes have bilingual explanations',()=>{
 for(const code of ['pull_diverged','no_upstream','git_merge_failed','merge_incomplete','merge_interrupted','merge_completed_after_error']) for(const zh of [true,false]) {
  const message=workbenchError(new Error(code),zh);
  assert.notEqual(message,code);
  assert.match(message,zh?/[\u4e00-\u9fff]/:/[a-z]/i);
 }
 assert.equal(workbenchError(new Error('merge_interrupted: git_timeout'),false),'The merge was interrupted before Git recorded it, so your working tree may contain partial merge changes. Review them in Source Control before committing; to retry, discard those changes and run the merge again.');
 assert.equal(workbenchError(new Error('merge_interrupted: git_timeout'),true),'合并在 Git 记录之前被中断，工作区可能包含部分合并结果。提交前请在源代码管理中检查这些更改；如需重试，请先丢弃这些更改再重新合并。');
 assert.match(workbenchError(new Error('git_merge_failed: hook refused'),false),/hook refused/);
});

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

test('discard conflicts use the dedicated retry message without changing diff conflict text', () => {
 assert.equal(workbenchError(new Error('file_conflict: changed'), false, 'discard'), 'Files changed since you opened this dialog. Nothing was discarded. Review the changes and try again.');
 assert.equal(workbenchError(new Error('index_conflict'), true, 'discard'), '自打开此对话框后文件已发生更改。未丢弃任何更改。请检查更改后重试。');
 assert.equal(workbenchError(new Error('index_conflict'), false), 'The index changed since this diff was shown. Refresh and try again.');
 assert.equal(workbenchError(new Error('discard_incomplete: recycled changed.ts; file_conflict'), false, 'discard'), 'Some changes were discarded before an error stopped the operation. The list has been refreshed; check what remains. recycled changed.ts; file_conflict');
 assert.equal(workbenchError(new Error('discard_incomplete'), true, 'discard'), '操作因错误中止前已丢弃部分更改。列表已刷新，请检查剩余内容。');
 assert.equal(workbenchError(new Error('discard_incomplete: recycled changed.ts; Unsupported runtime method'), false, 'discard'), 'Some changes were discarded before an error stopped the operation. The list has been refreshed; check what remains. recycled changed.ts; Unsupported runtime method');
});

test('fingerprint rejects non-file targets with a readable error', () => {
 assert.equal(workbenchError(new Error('invalid_file_type'), false), 'The target is not a regular file and cannot be used for this operation.');
 assert.equal(workbenchError(new Error('invalid_file_type'), true), '目标不是普通文件，无法执行此操作。');
});

test('worktree base errors explain how to recover', () => {
 assert.equal(workbenchError(new Error('start_point_not_found'), false), 'The selected base commit or branch could not be found. Refresh branches and try again.');
 assert.equal(workbenchError(new Error('start_point_not_found'), true), '找不到所选基准提交或分支。请刷新分支后重试。');
 assert.equal(workbenchError(new Error('invalid_request'), false), 'The request is invalid. Check the worktree options and try again.');
});

test('a changed reviewed push destination asks for a new review', () => {
 assert.equal(workbenchError(new Error('push_destination_changed'), false), 'The push destination changed since this preview. Review it again before pushing.');
 assert.equal(workbenchError(new Error('push_destination_changed'), true), '推送目标自预览后已变化。请重新检查后再推送。');
});

test('stash errors and a smart-switch receipt have bilingual explanations', () => {
 for(const code of ['nothing_to_stash','stash_not_found','stash_apply_failed']) for(const zh of [true,false]) {
  const message=workbenchError(new Error(code),zh);
  assert.notEqual(message,code);
  assert.match(message,zh?/[\u4e00-\u9fff]/:/[a-z]/i);
 }
 assert.equal(workbenchError(new Error('stash_switch_failed: {"error":"checkout_blocked","stash":{"oid":"abc123","restored":true,"dropped":true}}'),false),'Switch failed; your changes were restored. Staged changes were restored as unstaged.');
 assert.equal(workbenchError(new Error('stash_switch_failed: {"error":"checkout_blocked","stash":{"oid":"abc123","restored":false,"dropped":false}}'),true),'切换失败；你的更改无法恢复，暂存仍保留（abc123）。');
});

test('stash operation receipts preserve the saved OID and translate their nested error', () => {
 assert.equal(workbenchError(new Error('stash_operation_failed: {"oid":"abc123","error":"stash_not_found"}'),false),'The stash operation could not be confirmed. Review the worktree and Stashes. Stash OID: abc123. That stash entry was not found. Refresh the Stashes list and try again.');
 assert.equal(workbenchError(new Error('stash_operation_failed: {"oid":"abc123","error":"stash_not_found"}'),true),'无法确认暂存操作结果。请检查工作区和暂存列表。暂存 OID：abc123。 找不到该暂存条目。请刷新暂存列表后重试。');
 assert.equal(workbenchError(new Error('stash_switch_failed: {"error":"checkout_blocked","stash":{"oid":"abc123","restored":true,"dropped":true}}'),false),'Switch failed; your changes were restored. Staged changes were restored as unstaged.');
});

test('stash drop interference stays readable for standalone and nested switch failures', () => {
 const interference={oid:'0123456789abcdef',ourEntryDropped:false,restored:[{oid:'abcdef0123456789',message:'other'}],restoreFailed:[{oid:'fedcba9876543210',message:'failed',error:'git_failed'}],orderChanged:true,unknownEntryLost:true};
 const payload=JSON.stringify(interference);
 const standalone=workbenchError(new Error(`stash_drop_interfered: ${payload}`),false);
 assert.match(standalone,/Stash 0123456 was not dropped/);
 assert.match(standalone,/Restored: abcdef0 · other/);
 assert.match(standalone,/Could not restore: fedcba9 · failed/);
 assert.match(standalone,/git stash store -m <msg> <oid>/);
 const nested=workbenchError(new Error(`stash_switch_failed: ${JSON.stringify({error:'checkout_blocked',stash:{oid:'0123456789abcdef',restored:true,interference}})}`),true);
 assert.match(nested,/你的更改已恢复/);
 assert.match(nested,/暂存顺序已变化/);
 const wrapped=JSON.stringify({oid:'0123456789abcdef',error:'receipt_failed',dropped:false,interference});
 const wrappedEn=workbenchError(new Error(`stash_operation_failed: ${wrapped}`),false);
 assert.match(wrappedEn,/Stash OID: 0123456789abcdef/);
 assert.match(wrappedEn,/Could not restore: fedcba9 · failed/);
 assert.match(wrappedEn,/git fsck --unreachable/);
 const wrappedZh=workbenchError(new Error(`stash_operation_failed: ${wrapped}`),true);
 assert.match(wrappedZh,/恢复失败：fedcba9 · failed/);
 assert.match(wrappedZh,/git fsck --unreachable/);
});
