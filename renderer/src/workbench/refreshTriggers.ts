/** Freshness rules for the Source Control side bar and the Agent-changes panel.
 *
 * Both used to poll every 5 s. They now refresh from real events only: this app's own Git and file
 * actions, an agent turn or terminal run finishing in the same worktree, plus focus, the panel
 * becoming visible and the explicit Refresh button. Nothing here schedules work: an idle panel makes
 * no requests at all. */
export type WorktreeScope = { projectId:string; worktreePath?:string };

/** Provider turn outcomes are published as `state.changed` with the per-turn kind. */
const TURN_ENDED = new Set(['chat.turn.completed','chat.error']);
/** A terminal run ending is the usual "the command wrote files" signal for shell sessions. */
const STATUS_ENDED = new Set(['idle','exited','interrupted','error']);

const text = (value:unknown) => typeof value === 'string' ? value : '';

/** True when the event says the Git status, index or working tree of `scope` may have changed. */
export function eventTouchesWorktree(event:{event:string;data?:unknown}, scope:WorktreeScope, sessionIds:ReadonlySet<string>):boolean {
 const data = event.data as {kind?:unknown;projectId?:unknown;worktreePath?:unknown;sessionId?:unknown;status?:unknown}|undefined;
 if(!data || typeof data !== 'object') return false;
 if(event.event === 'state.changed') {
  if(data.kind === 'git') return data.projectId === scope.projectId && text(data.worktreePath) === (scope.worktreePath ?? '');
  return TURN_ENDED.has(text(data.kind)) && sessionIds.has(text(data.sessionId));
 }
 if(event.event === 'session.status') return STATUS_ENDED.has(text(data.status)) && sessionIds.has(text(data.sessionId));
 return false;
}
