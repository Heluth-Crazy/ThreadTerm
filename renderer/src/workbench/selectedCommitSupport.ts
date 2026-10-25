/** Capability failures are setup guidance, not raw runtime errors. */
export function selectedCommitUnsupportedText(code:string|undefined, zh:boolean):string {
 switch(code) {
  case 'git_unavailable': return zh
   ? '无法运行 Git。请从 git-scm.com 安装 Git 并确保它在 PATH 中，然后重启 ThreadTerm。'
   : 'Git could not run. Install Git from git-scm.com and make sure it is on PATH, then restart ThreadTerm.';
  case 'git_capability_probe_failed': return zh
   ? '无法检查 Git 是否支持选择性提交。请检查 Git 是否能正常运行，并确认临时文件夹可写，然后重启 ThreadTerm。'
   : 'Git support for selected commits could not be checked. Check that Git runs and the temporary folder is writable, then restart ThreadTerm.';
  case 'git_hook_run_unavailable': return zh
   ? '提交所选文件需要 Git 2.36 或更新版本（支持 git hook run）。请从 git-scm.com 更新 Git，然后重启 ThreadTerm。'
   : 'Committing selected files needs Git 2.36 or newer (git hook run support). Update Git from git-scm.com, then restart ThreadTerm.';
  case 'git_ref_transaction_unavailable': return zh
   ? '当前 Git 不支持选择性提交所需的引用事务。请从 git-scm.com 更新 Git，然后重启 ThreadTerm。'
   : 'This Git does not support the reference transactions needed for selected commits. Update Git from git-scm.com, then restart ThreadTerm.';
  default: return zh
   ? '选择性提交不可用。请更新 Git 并重启 ThreadTerm；如果仍有问题，请在报告中附上提示中的诊断代码。'
   : 'Selected commits are unavailable. Update Git and restart ThreadTerm; if the problem persists, include the diagnostic code from the tooltip in your report.';
 }
}
