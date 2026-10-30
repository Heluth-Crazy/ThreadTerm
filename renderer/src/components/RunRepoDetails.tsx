import { useState } from 'react';
import type { QuickLaunchRepoEntry } from '@threadterm/protocol';
import { repoBadges, repoDiff, repoFieldValue, type RepoDiff, type RepoDiffField } from '../runRepoConfig';

const fieldLabels:Record<RepoDiffField,[string,string]> = {
 command:['Command','命令'], shell:['Shell','Shell'], cwd:['Working directory','工作目录'], kind:['Type','类型'], env:['Environment','环境变量'], previewUrl:['Preview address','预览地址'],
};
const envChangeLabel:Record<Extract<RepoDiff,{field:'env'}>['change'],[string,string]> = {
 added:['Added','新增'], removed:['Removed','已移除'], changed:['Changed','已更改'],
};

export function RunRepoDetails({entry,zh,busy,onTrust,onEdit}:{entry:QuickLaunchRepoEntry;zh:boolean;busy:boolean;onTrust:() => void;onEdit:() => void}) {
 const [reviewing,setReviewing] = useState(false), copy = (en:string,cn:string) => zh ? cn : en;
 const badges = repoBadges(entry), diff = reviewing ? repoDiff(entry) : [], needsReview = badges.changed || !entry.trusted;
 return <div className="ql-repo-details">
  {needsReview && <button type="button" className={`ql-source-label ${badges.changed ? 'ql-repo-changed' : 'ql-repo-review'}`} data-testid={badges.changed ? `repo-changed-${entry.id}` : `repo-review-${entry.id}`} aria-expanded={reviewing} onClick={() => setReviewing(value => !value)}>{badges.changed ? copy('Changed in repo','仓库中已更改') : copy('Review repo entry','审查仓库条目')}</button>}
  {badges.missing.map(name => <button type="button" className="ql-source-label ql-repo-missing" data-testid={`repo-secret-${name}`} disabled={busy} key={name} onClick={onEdit}>{copy(`Needs ${name}`,`需要 ${name}`)}</button>)}
  {reviewing && <div className="ql-repo-diff" data-testid={`repo-diff-${entry.id}`}>
   {diff.length ? diff.map((row,index) => row.field === 'env'
    ? <section key={`env:${row.name}:${index}`}><strong>{fieldLabels.env[zh ? 1 : 0]}: {row.name} · {envChangeLabel[row.change][zh ? 1 : 0]}</strong>{row.before !== undefined && <div><span>{copy('Accepted','已接受')}</span><pre>{row.before}</pre></div>}{row.after !== undefined && <div><span>{copy('Current','当前')}</span><pre>{row.after}</pre></div>}</section>
    : <section key={row.field}><strong>{fieldLabels[row.field][zh ? 1 : 0]}</strong><div><span>{copy('Accepted','已接受')}</span><pre>{row.before || copy('(empty)','（空）')}</pre></div><div><span>{copy('Current','当前')}</span><pre>{row.after || copy('(empty)','（空）')}</pre></div></section>) : <>{(['command','shell','cwd','kind','env','previewUrl'] as RepoDiffField[]).map(field => <section key={field}><strong>{fieldLabels[field][zh ? 1 : 0]}</strong><div><span>{copy('Current','当前')}</span><pre>{repoFieldValue(entry,field) || copy('(empty)','（空）')}</pre></div></section>)}</>}
   <button type="button" className="btn btn-sm" data-testid={`repo-trust-${entry.id}`} disabled={busy} onClick={onTrust}>{copy('Trust','信任')}</button>
  </div>}
 </div>;
}
