/** Runtime error codes from file/Git/review commands → short user-facing text.
 * Unknown errors keep Git's own message so failures are never disguised. */
const known:Record<string,[string,string]> = {
 unknown_method:['需要重启 ThreadTerm 后台才能使用此功能（当前后台版本较旧）。','Restart the ThreadTerm runtime to use this feature (the running runtime is older).'],
 git_unavailable:['此目录不是 Git 仓库，或未找到 git。','This folder is not a Git repository, or git is not installed.'],
 pull_diverged:['本地与上游分支已分叉。可合并上游分支以继续。','The local and upstream branches have diverged. Merge the upstream branch to continue.'],
 no_upstream:['当前分支尚未配置上游。','This branch has no configured upstream.'],
 git_merge_failed:['Git 合并失败。','The Git merge failed.'],
 merge_incomplete:['合并尚未完成，仍处于合并状态。请检查合并提示并完成或中止合并。','The merge did not finish and is still in progress. Review the merge banner, then conclude or abort it.'],
 merge_interrupted:['合并在 Git 记录之前被中断，工作区可能包含部分合并结果。提交前请在源代码管理中检查这些更改；如需重试，请先丢弃这些更改再重新合并。','The merge was interrupted before Git recorded it, so your working tree may contain partial merge changes. Review them in Source Control before committing; to retry, discard those changes and run the merge again.'],
 merge_completed_after_error:['合并已完成，但 Git 随后报告了错误。请检查结果。','The merge completed, but Git reported an error afterward. Review the result.'],
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
 no_remote:['没有可推送的远程仓库。','No remote is configured to publish to.'],
 review_unavailable:['此会话没有可审查的 Git 工作区。','This session has no Git workspace to review.'],
 checkpoint_missing:['检查点不存在。','The checkpoint no longer exists.'],
 checkpoint_failed:['该检查点创建失败，无法对比。','This checkpoint failed to capture and cannot be compared.'],
 checkpoint_unavailable:['检查点对象已丢失或存储不可用，未显示对比，也未更改任何文件。','The checkpoint objects are missing or their store is unavailable. No diff was shown and no files were changed.'],
 file_too_large:['文件太大（超过 1 MB）。','The file is too large (over 1 MB).'],
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
};

export function workbenchError(error:unknown, zh:boolean, context?:'discard'):string {
 const raw = error instanceof Error ? error.message : String(error);
 // An older desktop preload rejects new methods before they reach the runtime.
 const discardIncomplete = raw === 'discard_incomplete' || raw.startsWith('discard_incomplete:') || raw.includes('discard_incomplete');
 const text = !discardIncomplete && /Unsupported runtime method/.test(raw) ? 'unknown_method' : raw;
 const code = discardIncomplete ? 'discard_incomplete' : Object.keys(known).find(key => text === key || text.startsWith(key + ':') || text.includes(key));
 if(code) {
  if(context === 'discard' && (code === 'file_conflict' || code === 'index_conflict')) return zh ? '自打开此对话框后文件已发生更改。未丢弃任何更改。请检查更改后重试。' : 'Files changed since you opened this dialog. Nothing was discarded. Review the changes and try again.';
  const marker = text.indexOf(`${code}:`);
  const detail = marker >= 0 ? text.slice(marker + code.length + 1).trim() : '';
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
