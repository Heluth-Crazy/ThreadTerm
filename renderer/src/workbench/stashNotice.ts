export function stashConflictNotice({oid,message,branch,zh}:{oid:string;message?:string;branch?:string;zh:boolean}) {
 const label=message ? `${oid.slice(0,7)} · ${message}` : oid.slice(0,7);
 if(branch) return zh
  ? {before:`已切换到 ${branch}；重新应用暂存 `,label,title:oid,after:' 时产生冲突。解决前会保留该暂存；已暂存的更改会以未暂存状态恢复。'}
  : {before:`Switched to ${branch}; re-applying stash `,label,title:oid,after:' produced conflicts. The stash is kept until you resolve them. Staged changes were restored as unstaged.'};
 return zh
  ? {before:'暂存 ',label,title:oid,after:' 已应用但产生冲突，解决前会保留；已暂存的更改会以未暂存状态恢复。'}
  : {before:'Stash ',label,title:oid,after:' was applied with conflicts and kept until you resolve them. Staged changes were restored as unstaged.'};
}
