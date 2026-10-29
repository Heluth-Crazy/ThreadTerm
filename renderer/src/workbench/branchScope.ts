/** Pure helpers for the Source Control "Branch" scope: everything the current branch changes
 * relative to a base, as a pull request would show it.
 *
 * The scope choice is per worktree and in memory only: a restart starts on Changes again, and
 * nothing here writes to disk. */
import type { GitBranch, GitCompareFile, GitCompareRef, GitCompareStatus } from '@threadterm/protocol';

// No imports at runtime: QA loads this module through Node's type stripping.
export type BranchScopeMode = 'changes' | 'branch';
export type BranchScopePreference = {mode:BranchScopeMode;base?:string;committedOnly:boolean};
const preferences = new Map<string, BranchScopePreference>();

export const branchScopeKey = (scope:{projectId:string;worktreePath?:string}) => `${scope.projectId}\0${scope.worktreePath ?? ''}`;
export function readBranchScopePreference(key:string):BranchScopePreference|undefined {
 const value = preferences.get(key);
 return value ? {...value} : undefined;
}
export function writeBranchScopePreference(key:string, value:BranchScopePreference) {
 preferences.set(key, {...value, ...(value.base ? {base:value.base} : {})});
}
/** Test hook: forget every remembered scope. */
export function forgetBranchScopePreferences() { preferences.clear(); }

export const compareStatusLetter = (status:GitCompareStatus) => status === 'added' ? 'A' : status === 'deleted' ? 'D' : status === 'renamed' ? 'R' : status === 'typechange' ? 'T' : 'M';
export function compareStatusLabel(status:GitCompareStatus, zh:boolean) {
 if(status === 'added') return zh ? '新增' : 'Added';
 if(status === 'deleted') return zh ? '删除' : 'Deleted';
 if(status === 'renamed') return zh ? '重命名' : 'Renamed';
 if(status === 'typechange') return zh ? '类型变更' : 'Type changed';
 return zh ? '修改' : 'Modified';
}

export function compareTotals(files:readonly Pick<GitCompareFile,'additions'|'deletions'>[]) {
 return files.reduce((total, file) => ({additions:total.additions + file.additions, deletions:total.deletions + file.deletions}), {additions:0, deletions:0});
}

/** "feature-x vs origin/main · 12 files · +340 −87" (the count gains "+" when the list is capped). */
export function compareHeaderText({branch, base, files, truncated = false, zh}:{branch:string;base:string;files:readonly Pick<GitCompareFile,'additions'|'deletions'>[];truncated?:boolean;zh:boolean}) {
 const {additions, deletions} = compareTotals(files), plus = truncated ? '+' : '';
 const count = zh ? `${files.length}${plus} 个文件` : `${files.length}${plus} file${files.length === 1 ? '' : 's'}`;
 // The minus in "+340 −87" is U+2212, not a hyphen: it lines up with the plus in the list.
 return `${branch} ${zh ? '对比' : 'vs'} ${base} · ${count} · +${additions} −${deletions}`;
}

/** Directories in path order, root first; each group keeps path order. This is the displayed order,
 * and the only order the diff walk and the roving keys use. */
export function compareGroups<T extends {path:string}>(files:readonly T[]):{dir:string;files:T[]}[] {
 const groups = new Map<string, T[]>();
 for(const file of [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
  const group = groups.get(dir);
  if(group) group.push(file); else groups.set(dir, [file]);
 }
 return [...groups].map(([dir, group]) => ({dir, files:group}));
}

/** The diff walk (Alt+←/→, F7) and the roving rows follow the displayed grouping, so a directory
 * grouped at the bottom of the list is also last in the walk. */
export const comparePaths = (files:readonly {path:string}[]) => compareGroups(files).flatMap(group => group.files.map(file => file.path));

export type CompareBaseOption = {ref:string;label:string;kind:'default'|'local'|'remote'};
/** The picker lists the resolved default base, then local branches, then remote branches. */
export function compareBaseOptions(branches:readonly GitBranch[], options:{current?:string;defaultRef?:string;zh:boolean}):CompareBaseOption[] {
 const found:CompareBaseOption[] = [], seen = new Set<string>();
 const add = (ref:string|undefined, label:string, kind:CompareBaseOption['kind']) => {
  if(!ref || seen.has(ref)) return;
  seen.add(ref); found.push({ref, label, kind});
 };
 add(options.defaultRef, options.defaultRef ? (options.zh ? `${options.defaultRef}（默认）` : `${options.defaultRef} (default)`) : '', 'default');
 for(const branch of branches) if(!branch.remote && !branch.current && branch.name !== options.current) add(branch.name, branch.name, 'local');
 for(const branch of branches) if(branch.remote) add(branch.name, branch.name, 'remote');
 return found;
}

/** A branch diff is editable on the working side only for an existing file in the working-tree scope. */
export const compareDiffEditable = (compare:{committedOnly?:boolean}|undefined, exists:boolean) => !compare?.committedOnly && exists;

/** A compare tab is identified by its base, the merge base it was computed from, the file's own base
 * path and its scope: `committedOnly` changes what the tab shows, so it must not be deduped away. */
export const compareTabSignature = (compare?:GitCompareRef) => !compare ? '' : [compare.base, compare.oid, compare.mergeBase, compare.originalPath ?? '', compare.committedOnly ? 'committed' : 'worktree'].join('\0');
export function sameDiffTabKey(current:{staged?:boolean;compare?:GitCompareRef}|undefined, next:{staged?:boolean;compare?:GitCompareRef}) {
 return Boolean(current?.staged) === Boolean(next.staged) && compareTabSignature(current?.compare) === compareTabSignature(next.compare);
}

/** The base side of `path` lives at its pre-rename path. The tab's own `originalPath` belongs to the
 * file the tab was opened with; every other path (Alt+→, retargeting) resolves from the current list,
 * so a rename's base path is never reused for an unrelated file. */
export function compareOriginalPath(path:string, firstPath:string|undefined, compare:{originalPath?:string}|undefined, files:readonly {path:string;originalPath?:string}[]|undefined) {
 // A path the list knows is a rename only when the list says so; the tab's own value never leaks to it.
 const known = files?.find(file => file.path === path);
 if(known) return known.originalPath;
 return path === firstPath ? compare?.originalPath : undefined;
}

export function compareEmptyText(base:string, zh:boolean) {
 return zh ? `与 ${base} 相比没有更改。` : `No changes compared to ${base}.`;
}
export function compareUnavailableText(zh:boolean) {
 return zh ? '无法确定比较基准分支。请在上方选择一个基准分支。' : 'No base branch could be determined. Choose a base branch above.';
}
export function compareStaleText(zh:boolean) {
 return zh ? '基准分支已变化，无法显示此差异。' : 'The base branch changed, so this diff could not be shown.';
}
export function compareReloadText(zh:boolean) {
 return zh ? '按当前基准重新载入' : 'Reload against the current base';
}
export function compareBaseMovedText(zh:boolean) {
 return zh ? '基准已更新，请刷新' : 'Base updated — refresh';
}
