import type { GitChange } from '@threadterm/protocol';

export type ChangeGroup = 'conflicts'|'staged'|'changes'|'untracked';
export type Decoration = { letter:string; tone:'modified'|'added'|'deleted'|'renamed'|'untracked'|'conflict'|'ignored' };

const CONFLICT = new Set(['DD','AU','UD','UA','DU','AA','UU']);

export const isConflict = (change:GitChange) => CONFLICT.has(change.indexStatus + change.worktreeStatus);

/** Porcelain XY → the Source Control groups a change belongs to (a file can be both staged and changed). */
export function changeGroups(change:GitChange):ChangeGroup[] {
 if(isConflict(change)) return ['conflicts'];
 if(change.untracked) return ['untracked'];
 const groups:ChangeGroup[] = [];
 if(change.indexStatus !== ' ' && change.indexStatus !== '?') groups.push('staged');
 if(change.worktreeStatus !== ' ' && change.worktreeStatus !== '?') groups.push('changes');
 return groups;
}

const tone = (status:string):Decoration['tone'] => status === 'A' ? 'added' : status === 'D' ? 'deleted' : status === 'R' || status === 'C' ? 'renamed' : 'modified';

/** Letter shown for a change in a given group, following VS Code's conventions. */
export function decorationFor(change:GitChange, group?:ChangeGroup):Decoration {
 if(isConflict(change)) return {letter:'!', tone:'conflict'};
 if(change.untracked) return {letter:'U', tone:'untracked'};
 const status = group === 'staged' ? change.indexStatus : group === 'changes' ? change.worktreeStatus : (change.worktreeStatus !== ' ' ? change.worktreeStatus : change.indexStatus);
 return {letter:status === 'R' || status === 'C' ? 'R' : status, tone:tone(status)};
}

const rank:Record<Decoration['tone'],number> = {conflict:6, deleted:5, modified:4, renamed:3, added:2, untracked:1, ignored:0};

/** Path → decoration for files, plus a rolled-up tone for every ancestor folder. */
export function decorationIndex(changes:readonly GitChange[]):{files:Map<string,Decoration>;folders:Map<string,Decoration['tone']>} {
 const files = new Map<string,Decoration>(), folders = new Map<string,Decoration['tone']>();
 for(const change of changes) {
  const decoration = decorationFor(change);
  files.set(change.path, decoration);
  const parts = change.path.split('/');
  for(let index = 1; index < parts.length; index++) {
   const folder = parts.slice(0, index).join('/');
   const current = folders.get(folder);
   if(!current || rank[decoration.tone] > rank[current]) folders.set(folder, decoration.tone);
  }
 }
 return {files, folders};
}
