/** Runtime error codes from file/Git/review commands → short user-facing text.
 * Unknown errors keep Git's own message so failures are never disguised. */
// No imports: QA tests load this module directly through Node's type stripping.
/** True when a rejected Undo already restored some paths; the runtime reports them in `completed=[…]`. */
export function undoRestoredPaths(error:unknown) {
 return /completed\s*=\s*\[\s*[^\]\s]/.test(error instanceof Error ? error.message : String(error));
}
export type StashDropInterference = {oid:string;ourEntryDropped:boolean;restored:{oid:string;message:string}[];restoreFailed:{oid:string;message:string;error:string}[];orderChanged:boolean;unknownEntryLost?:boolean};
type StashEntry = {oid:string;message:string};
const stashEntry = (value:unknown):StashEntry|undefined => value !== null && typeof value==='object' && typeof (value as StashEntry).oid==='string' && typeof (value as StashEntry).message==='string' ? value as StashEntry : undefined;
export function stashDropInterference(value:unknown):StashDropInterference|undefined {
 if(value===null || typeof value!=='object') return undefined;
 const input=value as Partial<StashDropInterference>;
 if(typeof input.oid!=='string'||typeof input.ourEntryDropped!=='boolean'||typeof input.orderChanged!=='boolean'||!Array.isArray(input.restored)||!Array.isArray(input.restoreFailed)) return undefined;
 const restored=input.restored.map(stashEntry), restoreFailed=input.restoreFailed.map(value=>stashEntry(value)&&typeof (value as {error?:unknown}).error==='string' ? value as StashDropInterference['restoreFailed'][number] : undefined);
 if(restored.some(value=>!value)||restoreFailed.some(value=>!value)) return undefined;
 return {oid:input.oid,ourEntryDropped:input.ourEntryDropped,restored:restored as StashEntry[],restoreFailed:restoreFailed as StashDropInterference['restoreFailed'],orderChanged:input.orderChanged,...(input.unknownEntryLost===undefined?{}:{unknownEntryLost:input.unknownEntryLost})};
}
export function stashInterferenceError(value:unknown,zh:boolean,includeEntries=true) {
 const interference=stashDropInterference(value);
 if(!interference) return undefined;
 const own=interference.ourEntryDropped
  ? zh ? `暂存 ${interference.oid.slice(0,7)} 已删除，但其他暂存条目发生了变化。` : `Stash ${interference.oid.slice(0,7)} was dropped, but other stash entries changed.`
  : zh ? `暂存 ${interference.oid.slice(0,7)} 未删除，因为其他暂存条目发生了变化。` : `Stash ${interference.oid.slice(0,7)} was not dropped because other stash entries changed.`;
 const restored=interference.restored.length ? `${zh?'已恢复：':'Restored: '}${interference.restored.map(value=>`${value.oid.slice(0,7)} · ${value.message}`).join(zh?'、':', ')}。` : '';
 const failed=interference.restoreFailed.length ? `${zh?'恢复失败：':'Could not restore: '}${interference.restoreFailed.map(value=>`${value.oid.slice(0,7)} · ${value.message}`).join(zh?'、':', ')}。` : '';
 const order=interference.orderChanged ? (zh?'暂存顺序已变化。':'Stash order changed.') : '';
 const unknown=interference.unknownEntryLost ? (zh?'可能丢失了一个未知暂存条目；请运行 git fsck --unreachable，然后使用 git stash store -m <msg> <oid> 恢复。':'An unknown stash entry may be lost; run git fsck --unreachable, then recover it with git stash store -m <msg> <oid>.') : '';
 return [own,...(includeEntries?[restored,failed]:[]),order,unknown].filter(Boolean).join(' ');
}
const known:Record<string,[string,string]> = {
 unknown_method:['需要重启 ThreadTerm 后台才能使用此功能（当前后台版本较旧）。','Restart the ThreadTerm runtime to use this feature (the running runtime is older).'],
 git_unavailable:['此目录不是 Git 仓库，或未找到 git。','This folder is not a Git repository, or git is not installed.'],
 pull_diverged:['本地与上游分支已分叉。可合并上游分支以继续。','The local and upstream branches have diverged. Merge the upstream branch to continue.'],
 no_upstream:['当前分支尚未配置上游。','This branch has no configured upstream.'],
 git_merge_failed:['Git 合并失败。','The Git merge failed.'],
 merge_incomplete:['合并尚未完成，仍处于合并状态。请检查合并提示并完成或中止合并。','The merge did not finish and is still in progress. Review the merge banner, then conclude or abort it.'],
 merge_interrupted:['合并在 Git 记录之前被中断，工作区可能包含部分合并结果。提交前请在源代码管理中检查这些更改；如需重试，请先丢弃这些更改再重新合并。','The merge was interrupted before Git recorded it, so your working tree may contain partial merge changes. Review them in Source Control before committing; to retry, discard those changes and run the merge again.'],
 merge_completed_after_error:['合并已完成，但 Git 随后报告了错误。请检查结果。','The merge completed, but Git reported an error afterward. Review the result.'],
 commit_not_found:['找不到该提交。请刷新历史后重试。','The commit could not be found. Refresh history and try again.'],
 branch_changed:['分支自重置后已变化，无法撤销。请刷新历史。','The branch changed after the reset. Undo is unavailable; refresh history.'],
 head_moved:['HEAD 自打开此对话框后已变化。请刷新历史后重试。','HEAD changed since this dialog opened. Refresh history and try again.'],
 not_ancestor:['所选提交不在当前分支上。','The selected commit is not on the current branch.'],
 operation_in_progress:['另一个 Git 操作正在进行。请先完成或中止它。','Another Git operation is in progress. Finish or abort it first.'],
 cherry_pick_would_overwrite:['拣选会覆盖本地更改。请先检查或暂存这些更改。','Cherry-pick would overwrite local changes. Review or stash them first.'],
 revert_would_overwrite:['还原会覆盖本地更改。请先检查或暂存这些更改。','Revert would overwrite local changes. Review or stash them first.'],
 unresolved_conflicts:['仍有未解决的冲突。请先解决并暂存它们。','Unresolved conflicts remain. Resolve and stage them first.'],
 invalid_mainline:['合并提交需要有效的主线父提交。','A merge commit needs a valid mainline parent.'],
 mainline_required:['还原合并提交时请选择主线父提交。','Choose a mainline parent to revert a merge commit.'],
 detached_head:['分离 HEAD 时无法执行此操作。请先检出一个分支。','This action is unavailable in detached HEAD. Check out a branch first.'],
 operation_not_in_progress:['该 Git 操作已不再进行。请刷新后重试。','That Git operation is no longer in progress. Refresh and try again.'],
 operation_kind_mismatch:['当前 Git 操作与此操作不匹配。请刷新后重试。','The current Git operation does not match this action. Refresh and try again.'],
 reset_undo_not_found:['找不到原重置操作的记录，无法撤销。','The original reset receipt is unavailable, so this reset cannot be undone.'],
 reset_undo_invalid:['此重置记录与当前分支或工作树不匹配，无法撤销。','This reset receipt does not match the current branch or worktree and cannot be undone.'],
 invalid_reset_undo:['此重置已无法撤销。请刷新历史后重试。','This reset can no longer be undone. Refresh history and try again.'],
 git_timeout:['Git 操作超时。','The Git command timed out.'],
 file_exists:['同名文件或文件夹已存在。','A file or folder with that name already exists.'],
 file_not_found:['文件不存在或已被移动。','The file no longer exists.'],
 invalid_name:['名称不可用：不能包含 < > : " | ? * 或以点、空格结尾，也不能是保留名称。','Invalid name: avoid < > : " | ? *, trailing dots or spaces, and reserved names.'],
 invalid_path:['路径无效或超出工作区范围。','Invalid path, or outside this workspace.'],
 path_escape:['目标位于工作区之外（链接或联接），已拒绝。','The target resolves outside this workspace and was refused.'],
 recycle_unavailable:['此磁盘没有回收站，无法可恢复地删除。','This drive has no Recycle Bin, so it cannot be deleted recoverably.'],
 recycle_failed:['移动到回收站失败。','Moving to the Recycle Bin failed.'],
 index_conflict:['暂存区已被其他操作修改，请刷新后重试。','The index changed since this diff was shown. Refresh and try again.'],
 index_unmerged:['该文件存在未解决的冲突，请先解决冲突。','This file has unresolved conflicts. Resolve them first.'],
 file_conflict:['文件已在磁盘上被修改，请刷新后重试。','The file changed on disk. Refresh and try again.'],
 nothing_staged:['没有已暂存的更改。先暂存文件或更改块。','Nothing is staged. Stage files or hunks first.'],
 branch_not_merged:['该分支尚未合并。','This branch is not fully merged.'],
 branch_not_found:['找不到该分支。','Branch not found.'],
 invalid_branch:['分支名称无效。','Invalid branch name.'],
 invalid_request:['请求无效。请检查工作树选项后重试。','The request is invalid. Check the worktree options and try again.'],
 start_point_not_found:['找不到所选基准提交或分支。请刷新分支后重试。','The selected base commit or branch could not be found. Refresh branches and try again.'],
 branch_checked_out_elsewhere:['该分支已在另一个工作树中检出。','This branch is already checked out in another worktree.'],
 checkout_would_overwrite:['切换分支会覆盖本地更改。请在源代码管理中检查这些文件。','Switching branches would overwrite local changes. Review the files in Source Control.'],
 checkout_blocked:['Git 阻止了分支切换。请检查工作区状态后重试。','Git blocked the branch switch. Review the worktree state and try again.'],
 nothing_to_stash:['没有可暂存的更改。','There are no changes to stash.'],
 stash_not_found:['找不到该暂存条目。请刷新暂存列表后重试。','That stash entry was not found. Refresh the Stashes list and try again.'],
 stash_apply_failed:['无法应用该暂存。暂存已保留，请检查工作区后重试。','The stash could not be applied. It was kept; review the worktree and try again.'],
 no_remote:['没有可推送的远程仓库。','No remote is configured to publish to.'],
 push_rejected_non_ff:['远程分支有你尚未获取的提交。请拉取并检查，或在确认后使用带租约的强制推送。','The remote branch has commits you do not have. Pull and review them, or use a lease-protected force push after confirmation.'],
 push_lease_stale:['远程分支自预览后已发生变化。请获取并重新检查后再推送。','The remote branch changed since this preview. Fetch and review it again before pushing.'],
 push_destination_changed:['推送目标自预览后已变化。请重新检查后再推送。','The push destination changed since this preview. Review it again before pushing.'],
 push_rejected_hook:['远程仓库的钩子拒绝了此推送。','A remote hook rejected this push.'],
 push_auth_failed:['无法通过远程仓库的身份验证。','Could not authenticate with the remote repository.'],
 push_remote_unreachable:['无法连接到远程仓库。','Could not reach the remote repository.'],
 review_unavailable:['此会话没有可审查的 Git 工作区。','This session has no Git workspace to review.'],
 checkpoint_missing:['检查点不存在。','The checkpoint no longer exists.'],
 checkpoint_failed:['该检查点创建失败，无法对比。','This checkpoint failed to capture and cannot be compared.'],
 checkpoint_unavailable:['检查点对象已丢失或存储不可用，未显示对比，也未更改任何文件。','The checkpoint objects are missing or their store is unavailable. No diff was shown and no files were changed.'],
 file_too_large:['文件太大（超过 1 MB）。','The file is too large (over 1 MB).'],
 // Workbook preview (`design.md` §6). The line above is the 1 MiB text-reader limit, so a workbook at
 // the 100 MiB limit goes through `officeSheetError` instead of `workbenchError`.
 unsupported_document:['无法读取此文件，它可能已损坏。','Cannot read this file; it may be damaged.'],
 document_protected:['此文件受密码保护。','This file is password-protected.'],
 file_changed:['文件已更改，请重新载入。','The file changed. Reload.'],
 sheet_out_of_memory:['此工作簿过大，无法预览。','This workbook is too large to preview.'],
 sheet_too_complex:['此工作簿过大，无法预览。','This workbook is too large to preview.'],
 sheet_worker_failed:['预览已停止，请重新载入。','Preview stopped. Reload.'],
 sheet_not_found:['工作簿已关闭，请重新载入。','The workbook was closed. Reload.'],
 binary_file:['二进制文件无法以文本显示。','Binary files cannot be shown as text.'],
 invalid_file_type:['目标不是普通文件，无法执行此操作。','The target is not a regular file and cannot be used for this operation.'],
 invalid_search_pattern:['搜索表达式无效。','Invalid search expression.'],
 invalid_glob:['包含/排除规则无效。','Invalid include/exclude pattern.'],
 operation_outcome_unknown:['上一次操作结果未知，请刷新确认状态。','The previous attempt has an unknown outcome. Refresh to check the current state.'],
 git_status_changed:['Git 状态已变化。请刷新后重试。','Git status changed. Refresh and try again.'],
 git_selected_commit_unsupported:['当前 Git 版本不支持选择性提交。请升级 Git 后重试。','This Git version does not support selected commits. Upgrade Git and try again.'],
 git_selected_commit_stale:['暂存区或 HEAD 已变化。请刷新后重新选择文件。','The index or HEAD changed. Refresh and select the files again.'],
 git_selected_commit_conflict_state:['仓库处于合并或冲突状态。请先解决冲突。','The repository is in a merge or conflict state. Resolve it first.'],
 git_selected_commit_index_locked:['Git 暂存区正被其他操作使用。请稍后刷新重试。','Git’s index is in use by another operation. Refresh and try again shortly.'],
 git_selected_commit_invalid_selection:['所选暂存文件已变化。请刷新后重新选择。','The selected staged files changed. Refresh and select them again.'],
 git_selected_commit_cross_root_rename:['重命名跨越工作区根目录，无法选择性提交。','The rename crosses the workspace root and cannot be selectively committed.'],
 git_selected_commit_invalid_message:['提交信息无效。','The commit message is invalid.'],
 git_selected_commit_hook_failed:['Git 钩子失败，未创建提交。','A Git hook failed; no commit was created.'],
 git_selected_commit_hook_changed_index:['Git 钩子修改了暂存区，未创建提交。请刷新后检查更改。','A Git hook changed the index; no commit was created. Refresh and inspect the changes.'],
 git_selected_commit_signing_failed:['提交签名失败，未创建提交。','Commit signing failed; no commit was created.'],
 git_selected_commit_ref_conflict:['提交引用已变化，未创建提交。请刷新后重试。','The commit reference changed; no commit was created. Refresh and try again.'],
 git_selected_commit_cleanup_failed:['提交已发布，但清理报告错误。请刷新确认状态。','The commit was published, but cleanup reported an error. Refresh to confirm the state.'],
 discard_incomplete:['操作因错误中止前已丢弃部分更改。列表已刷新，请检查剩余内容。','Some changes were discarded before an error stopped the operation. The list has been refreshed; check what remains.'],
 undo_conflict:['自该操作后文件或引用已发生变化，因此未撤销任何内容。请检查当前状态后重试。','Files or refs changed after this action, so nothing was undone. Review the current state and try again.'],
 undo_unavailable:['用于撤销的 Git 对象已不可用。','The Git objects needed to undo this action are no longer available.'],
 undo_capture_failed:['无法在执行操作前捕获撤销信息，因此未作任何更改。请检查后重试。','Undo information could not be captured before this action, so nothing changed. Review and try again.'],
 undo_capture_unsupported:['此工作区无法安全保存撤销所需的信息，因此未作任何更改。','This worktree cannot safely capture the information needed for Undo, so nothing changed.'],
 undo_already_applied:['该操作已被撤销。','This action has already been undone.'],
 undo_already_undone:['该操作已被撤销。','This action has already been undone.'],
 undo_capture_changed:['该操作的撤销记录已变化，未作任何更改。请刷新后重试。','This action’s undo record changed, so nothing changed. Refresh and try again.'],
 // Branch scope: the comparison base could not be resolved, has no common history, or moved.
 compare_base_unavailable:['无法确定比较基准分支。请选择一个基准分支。','No base branch could be determined. Choose a base branch.'],
 compare_no_merge_base:['当前分支与基准分支没有共同历史，无法比较。请选择其他基准分支。','The current branch and the base have no common history. Choose another base branch.'],
 compare_unborn:['此仓库还没有提交，无法比较。请先创建第一次提交。','This repository has no commits yet. Create the first commit before comparing.'],
 compare_stale:['基准分支或工作区已变化，因此未显示此差异。请刷新分支视图后重新打开该文件。','The base or the worktree changed, so this diff was not shown. Refresh the Branch view and open the file again.'],
};

export function workbenchError(error:unknown, zh:boolean, context?:'discard'):string {
 const raw = error instanceof Error ? error.message : String(error);
 // An older desktop preload rejects new methods before they reach the runtime.
 const discardIncomplete = raw === 'discard_incomplete' || raw.startsWith('discard_incomplete:') || raw.includes('discard_incomplete');
 const text = !discardIncomplete && /Unsupported runtime method/.test(raw) ? 'unknown_method' : raw;
 if(text.includes('stash_drop_interfered:')) {
  const marker=text.indexOf('stash_drop_interfered:')+'stash_drop_interfered:'.length;
  try { const notice=stashInterferenceError(JSON.parse(text.slice(marker).trim()),zh); if(notice) return notice; } catch { /* Fall through to the original error. */ }
 }
 if(text.includes('stash_operation_failed:')) {
  const marker=text.indexOf('stash_operation_failed:')+'stash_operation_failed:'.length;
  try {
   const result=JSON.parse(text.slice(marker).trim()) as {oid?:unknown;error?:unknown;interference?:unknown};
   const oid=typeof result.oid==='string' ? result.oid : undefined;
   const detail=typeof result.error==='string' ? workbenchError(result.error,zh) : undefined;
   // Wrapped interference still names entries whose restore failed; Stashes cannot show those.
   const interference=stashInterferenceError(result.interference,zh);
   const base=zh
    ? `无法确认暂存操作结果。请检查工作区和暂存列表。暂存 OID：${oid ?? '未知'}。${detail ? ` ${detail}` : ''}`
    : `The stash operation could not be confirmed. Review the worktree and Stashes. Stash OID: ${oid ?? 'unknown'}.${detail ? ` ${detail}` : ''}`;
   return interference ? `${base} ${interference}` : base;
  } catch { /* Fall through to Git's original message for a malformed receipt. */ }
 }
 if(text.includes('stash_switch_failed:')) {
  const marker=text.indexOf('stash_switch_failed:')+'stash_switch_failed:'.length;
  try {
   const result=JSON.parse(text.slice(marker).trim()) as {stash?:{oid?:unknown;restored?:unknown;interference?:unknown}};
   const oid=typeof result.stash?.oid==='string' ? result.stash.oid : undefined;
   const interference=stashInterferenceError(result.stash?.interference,zh);
   const base=result.stash?.restored === true ? (zh ? '切换失败；你的更改已恢复。已暂存的更改会以未暂存状态恢复。' : 'Switch failed; your changes were restored. Staged changes were restored as unstaged.') : zh
    ? `切换失败；你的更改无法恢复，暂存仍保留${oid ? `（${oid}）` : ''}。`
    : `Switch failed; your changes could not be restored. The stash was kept${oid ? ` (${oid})` : ''}.`;
   return interference ? `${base} ${interference}` : base;
  } catch { /* Fall through to Git's original message for a malformed receipt. */ }
 }
 const code = discardIncomplete ? 'discard_incomplete' : Object.keys(known).find(key => text === key || text.startsWith(key + ':') || text.includes(key));
 if(code) {
  if(context === 'discard' && (code === 'file_conflict' || code === 'index_conflict')) return zh ? '自打开此对话框后文件已发生更改。未丢弃任何更改。请检查更改后重试。' : 'Files changed since you opened this dialog. Nothing was discarded. Review the changes and try again.';
  const marker = text.indexOf(`${code}:`);
  const detail = marker >= 0 ? text.slice(marker + code.length + 1).trim() : '';
  // An Undo that restored some paths must not claim that nothing changed, whichever
  // code reported the failure (conflict, unsupported install, or capture error).
  if((code==='undo_conflict'||code==='undo_capture_unsupported'||code==='undo_capture_failed')&&undoRestoredPaths(detail)) return (zh ? '撤销在恢复部分路径后失败。请检查当前状态和保留的恢复文件。' : 'Undo restored some paths before it failed. Review the current state and any retained recovery files.') + (detail ? ` ${detail}` : '');
  if(code === 'branch_checked_out_elsewhere' && detail) {
   try {
    const owner=JSON.parse(detail) as {path?:unknown;missing?:unknown};
    if(typeof owner.path === 'string') return zh
     ? `该分支已在另一个工作树中检出：${owner.path}${owner.missing === true ? '。该工作树文件夹缺失；请运行 git worktree prune 后重试。' : ''}`
     : `This branch is already checked out in another worktree: ${owner.path}${owner.missing === true ? '. The worktree folder is missing; run git worktree prune and try again.' : ''}`;
   } catch { /* Older runtimes return the path as plain text below. */ }
  }
  return known[code][zh ? 0 : 1] + (detail && code !== 'recycle_failed' && code !== 'merge_interrupted' ? ` ${detail}` : '');
 }
 const git = /git_failed:\s*([\s\S]*)/.exec(text);
 if(git) return git[1].trim() || (zh ? 'Git 命令失败。' : 'The Git command failed.');
 return text;
}

export const isUnavailable = (error:unknown) => /unknown_method|Unsupported runtime method|git_unavailable|review_unavailable/.test(error instanceof Error ? error.message : String(error));

/** Workbook preview line (`design.md` §6): the sheet limits differ from the text reader's, so
 * `file_too_large` means 100 MiB here and the text-reader wording stays for text files. */
export function officeSheetError(error:unknown, zh:boolean):string {
 const raw = error instanceof Error ? error.message : String(error);
 // A view on another computer talks to that computer's runtime; an older one has no sheet method.
 const remote = typeof window !== 'undefined' && Boolean((window as {threadterm?:{machineId?:string}}).threadterm?.machineId
  && (window as {threadterm?:{machineId?:string}}).threadterm?.machineId !== 'local');
 if(remote && /unknown_method|Unsupported runtime method/.test(raw)) return zh ? '请在那台电脑上更新 ThreadTerm。' : 'Update ThreadTerm on that computer.';
 if(/\bfile_too_large\b/.test(raw)) return zh ? '文件过大，无法预览（超过 100 MiB）。' : 'Too large to preview (over 100 MiB).';
 return workbenchError(error, zh);
}
