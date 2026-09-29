/** Runtime error codes from file/Git/review commands → short user-facing text.
 * Unknown errors keep Git's own message so failures are never disguised. */
const known:Record<string,[string,string]> = {
 unknown_method:['需要重启 ThreadTerm 后台才能使用此功能（当前后台版本较旧）。','Restart the ThreadTerm runtime to use this feature (the running runtime is older).'],
 git_unavailable:['此目录不是 Git 仓库，或未找到 git。','This folder is not a Git repository, or git is not installed.'],
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
 no_remote:['没有可推送的远程仓库。','No remote is configured to publish to.'],
 review_unavailable:['此会话没有可审查的 Git 工作区。','This session has no Git workspace to review.'],
 checkpoint_missing:['检查点不存在。','The checkpoint no longer exists.'],
 checkpoint_failed:['该检查点创建失败，无法对比。','This checkpoint failed to capture and cannot be compared.'],
 file_too_large:['文件太大（超过 1 MB）。','The file is too large (over 1 MB).'],
 binary_file:['二进制文件无法以文本显示。','Binary files cannot be shown as text.'],
 invalid_search_pattern:['搜索表达式无效。','Invalid search expression.'],
 invalid_glob:['包含/排除规则无效。','Invalid include/exclude pattern.'],
 operation_outcome_unknown:['上一次操作结果未知，请刷新确认状态。','The previous attempt has an unknown outcome. Refresh to check the current state.'],
};

export function workbenchError(error:unknown, zh:boolean):string {
 const raw = error instanceof Error ? error.message : String(error);
 // An older desktop preload rejects new methods before they reach the runtime.
 const text = /Unsupported runtime method/.test(raw) ? 'unknown_method' : raw;
 const code = Object.keys(known).find(key => text === key || text.startsWith(`${key}:`) || text.includes(`${key}`));
 if(code) {
  const detail = text.startsWith(`${code}:`) ? text.slice(code.length + 1).trim() : '';
  return known[code][zh ? 0 : 1] + (detail && code !== 'recycle_failed' ? ` ${detail}` : '');
 }
 const git = /git_failed:\s*([\s\S]*)/.exec(text);
 if(git) return git[1].trim() || (zh ? 'Git 命令失败。' : 'The Git command failed.');
 return text;
}

export const isUnavailable = (error:unknown) => /unknown_method|Unsupported runtime method|git_unavailable|review_unavailable/.test(error instanceof Error ? error.message : String(error));
