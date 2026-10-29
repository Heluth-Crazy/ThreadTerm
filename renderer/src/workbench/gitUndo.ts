import type { GitUndoEntry } from '@threadterm/protocol';

/** Undo notices stay actionable long enough to be discovered; ordinary notices keep the shared short timeout. */
export const undoNoticeTimeout = (hasUndo:boolean) => hasUndo ? 30000 : 4000;

/** The current immediate Undo is shared by every surface for one worktree, but is never persisted. */
export type LatestUndoNotice = {journalId:string;kind:GitUndoEntry['kind'];label:string;expiresAt:number};
type UndoListener = () => void;
const latestUndoByWorktree = new Map<string,LatestUndoNotice>();
const undoListeners = new Map<string,Set<UndoListener>>();
const undoExpiryTimers = new Map<string,ReturnType<typeof setTimeout>>();

function notifyLatestUndo(worktreeKey:string) {
 for(const listener of undoListeners.get(worktreeKey) ?? []) listener();
}

/** Read the current notice, removing a stale entry even if the page was suspended past its timer. */
export function latestUndo(worktreeKey:string, now=Date.now()):LatestUndoNotice|undefined {
 const notice=latestUndoByWorktree.get(worktreeKey);
 if(notice&&notice.expiresAt<=now) {
  latestUndoByWorktree.delete(worktreeKey);
  const timer=undoExpiryTimers.get(worktreeKey);if(timer)clearTimeout(timer);
  undoExpiryTimers.delete(worktreeKey);
  notifyLatestUndo(worktreeKey);
  return undefined;
 }
 return notice;
}

/** A new completed destructive action supersedes the older immediate Undo for this worktree. */
export function publishLatestUndo(worktreeKey:string, notice:Omit<LatestUndoNotice,'expiresAt'>, now=Date.now()):LatestUndoNotice {
 const value={...notice,expiresAt:now+undoNoticeTimeout(true)};
 latestUndoByWorktree.set(worktreeKey,value);
 const previous=undoExpiryTimers.get(worktreeKey);if(previous)clearTimeout(previous);
 const timer=setTimeout(()=>{
  if(latestUndoByWorktree.get(worktreeKey)===value) {
   latestUndoByWorktree.delete(worktreeKey);undoExpiryTimers.delete(worktreeKey);notifyLatestUndo(worktreeKey);
  }
 },undoNoticeTimeout(true));
 if(typeof timer==='object'&&'unref' in timer)timer.unref();
 undoExpiryTimers.set(worktreeKey,timer);
 notifyLatestUndo(worktreeKey);
 return value;
}

/** Clear only the exact notice that was consumed; a newer action must remain undoable. */
export function consumeLatestUndo(worktreeKey:string, journalId:string, now=Date.now()) {
 const notice=latestUndo(worktreeKey,now);
 if(!notice||notice.journalId!==journalId)return;
 latestUndoByWorktree.delete(worktreeKey);
 const timer=undoExpiryTimers.get(worktreeKey);if(timer)clearTimeout(timer);
 undoExpiryTimers.delete(worktreeKey);notifyLatestUndo(worktreeKey);
}

export function subscribeLatestUndo(worktreeKey:string, listener:UndoListener) {
 const listeners=undoListeners.get(worktreeKey) ?? new Set<UndoListener>();
 listeners.add(listener);undoListeners.set(worktreeKey,listeners);
 return ()=>{listeners.delete(listener);if(!listeners.size)undoListeners.delete(worktreeKey);};
}

/** A success notice carries the journal entry whose action it reports, so the Undo button belongs to that notice. */
export type UndoBoundNotice<T=unknown> = {message:T;undoId?:string};

/**
 * Undo is offered only while the notice on screen still names the shared latest action. A later
 * unrelated notice or issue replaces the object (clearing `undoId`), and an expired or consumed
 * journal notice stops matching, so neither the button nor Ctrl/Cmd+Z can act on a stale message.
 */
export function noticeUndoId<T>(notice:UndoBoundNotice<T>|undefined, latest:Pick<LatestUndoNotice,'journalId'>|undefined):string|undefined {
 if(!notice?.undoId||latest?.journalId!==notice.undoId) return undefined;
 return notice.undoId;
}

/** A reset receipt with a journal entry is retired as soon as that entry is undone, expires, or is superseded. */
export function resetReceiptWithUndo<T extends {undoId?:string}>(receipt:T|undefined, latest:Pick<LatestUndoNotice,'journalId'>|undefined):T|undefined {
 if(receipt?.undoId&&latest?.journalId!==receipt.undoId) return undefined;
 return receipt;
}

/** The journal label is preferred, with a localized fallback for entries written by an older runtime. */
export function undoEntryLabel(entry:Pick<GitUndoEntry,'kind'|'label'|'pathCount'|'partial'|'recycledCount'>,zh:boolean) {
 if(entry.partial) return zh ? '部分已撤销' : 'Partially undone';
 const recycled=entry.recycledCount ?? 0;
 // Discard labels are composed from the counted undoable and recycled paths so both languages agree.
 if(entry.kind==='discard') {
  const count=entry.pathCount;
  if(!count&&recycled) return zh ? `${recycled} 个文件已移到回收站` : `${recycled} file${recycled===1?'':'s'} moved to the Recycle Bin`;
  const suffix=recycled ? (zh ? `（另有 ${recycled} 个已移到回收站）` : ` (${recycled} more moved to the Recycle Bin)`) : '';
  return zh ? `丢弃 ${count} 个文件的更改${suffix}` : `Discarded changes in ${count} file${count===1?'':'s'}${suffix}`;
 }
 const label=entry.label.trim();
 if(label) {
  if(!zh) return label;
  if(entry.kind==='branch') return label.startsWith('Delete ') ? `删除 ${label.slice('Delete '.length)}` : '删除分支';
  if(entry.kind==='stash') return label.startsWith('Remove stash: ') ? `删除暂存：${label.slice('Remove stash: '.length)}` : '删除暂存';
  if(entry.kind==='reset') return label.startsWith('Reset ') ? `重置 ${label.slice('Reset '.length)}` : '重置分支';
 }
 if(entry.kind==='branch') return zh ? '删除分支' : 'Deleted branch';
 if(entry.kind==='stash') return zh ? '删除暂存' : 'Dropped stash';
 return zh ? '重置分支' : 'Reset branch';
}

export { undoRestoredPaths } from './errors';
