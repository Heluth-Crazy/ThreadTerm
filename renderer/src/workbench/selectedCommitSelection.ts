import type { GitChange } from '@threadterm/protocol';
import type { ChangeGroup } from './gitDecorations';

export type SelectedCommitGroup = Extract<ChangeGroup, 'staged'|'changes'|'untracked'>;

/** Selections intentionally include root and status group: a dual-status row is two choices. */
export const selectedCommitKey = (root:string, group:SelectedCommitGroup, path:string) => `${root}\u0000${group}\u0000${path}`;

export const selectedChanges = (selection:ReadonlySet<string>, root:string, group:SelectedCommitGroup, changes:readonly GitChange[]) =>
 changes.filter(change => selection.has(selectedCommitKey(root, group, change.path)));

export const toggleSelectedChange = (selection:ReadonlySet<string>, root:string, group:SelectedCommitGroup, path:string) => {
 const next=new Set(selection), key=selectedCommitKey(root,group,path);
 if(next.has(key))next.delete(key); else next.add(key);
 return next;
};

export const setGroupSelection = (selection:ReadonlySet<string>, root:string, group:SelectedCommitGroup, changes:readonly GitChange[], selected:boolean) => {
 const next=new Set(selection);
 for(const change of changes) {
  const key=selectedCommitKey(root,group,change.path);
  if(selected)next.add(key); else next.delete(key);
 }
 return next;
};

export const clearSelectedChanges = (selection:ReadonlySet<string>, root:string, group:SelectedCommitGroup, changes:readonly GitChange[]) =>
 setGroupSelection(selection,root,group,changes,false);
