import type { Session } from '@threadterm/protocol';
import { canonicalScopePath, displayPath, sameCanonicalScope } from '../projectScope';
import { runState, type RunView as RunStateView } from '../quickLaunch';
import { isKeyboardEditableTarget } from './scmKeyboard';

/** The worktree the Run view speaks for: one project, one root. */
export type RunScope = { projectId:string; root:string };
/** A runnable entry as the view, the popover and the palette name it. A detected entry's command text is never
 * carried here: it always comes from the files through `detected:<key>`. */
export type RunEntryRef = { commandId:string; name:string; source:'saved'|'detected' };
/** A command addressed to one workbench's Run view: one entry of its current worktree (palette), every run of it
 * (palette), or the current configuration (the F5 keys). */
export type RunCommandRequest = { key:string; commandId?:string; detectedKey?:string; stopAll?:boolean; current?:RunKeyAction };

export const DETECTED_PREFIX = 'detected:';
export const detectedCommandId = (key:string) => `${DETECTED_PREFIX}${key}`;
/** The detection key behind a `detected:<key>` run, or undefined for a saved command. */
export const detectedKeyOf = (commandId:string) => commandId.startsWith(DETECTED_PREFIX) ? commandId.slice(DETECTED_PREFIX.length) : undefined;
export const entryRefOf = (commandId:string, name:string):RunEntryRef => ({ commandId, name, source:detectedKeyOf(commandId) ? 'detected' : 'saved' });

/** Exactly the statuses the runtime admits a run in, so Running shows what "one active run per entry and root" owns. */
export const ACTIVE_RUN_STATUSES:readonly string[] = ['starting', 'running', 'idle', 'waiting'];
export const isActiveRun = (session:Session) => Boolean(session.run) && !session.archived && !session.readOnly && ACTIVE_RUN_STATUSES.includes(session.status);

/** One row of the Running section. */
export type RunningRow = { session:Session; state:RunStateView; name:string; commandId:string; worktree:string; current:boolean };

/** Active runs of the project across its worktrees: the current worktree's first, then the newest first. */
export function runningRows(sessions:readonly Session[], scope:RunScope):RunningRow[] {
 return sessions
  .filter(session => session.projectId === scope.projectId && isActiveRun(session))
  .map(session => ({
   session,
   state:runState(session),
   name:session.run!.name,
   commandId:session.run!.commandId,
   worktree:worktreeLabel(session.worktreePath),
   current:sameCanonicalScope(session.worktreePath, scope.root),
  }))
  .sort((left, right) => Number(right.current) - Number(left.current) || right.session.createdAt.localeCompare(left.session.createdAt) || right.session.updatedAt.localeCompare(left.session.updatedAt));
}

/** The last path segment of a worktree, e.g. `ThreadTerm-v3` or `feature-run`, without the runtime's extended form. */
export function worktreeLabel(path:string|undefined):string {
 const value = displayPath(path).replace(/[\\/]+$/, '');
 return value.slice(Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/')) + 1) || value;
}

/** The chat that started a run, when the snapshot still holds it. A run the user started has no `startedBy`. */
export const startedByChat = (startedBy:string|undefined, sessions:readonly Session[]):Session|undefined => startedBy ? sessions.find(session => session.id === startedBy) : undefined;
/** The Agent tag's tooltip: `Started by <chat title>` / `由 <chat title> 启动`. The title is resolved from the
 * snapshot's sessions; a chat that is gone falls back to the recorded session id. */
export function agentStartLabel(startedBy:string|undefined, sessions:readonly Session[], zh:boolean):string|undefined {
 if (!startedBy) return undefined;
 const title = startedByChat(startedBy, sessions)?.title?.trim() || startedBy;
 return zh ? `由 ${title} 启动` : `Started by ${title}`;
}

/** How long a run has been up; absent (0) for a timestamp the runtime did not record. */
export function uptimeMs(createdAt:string, now:number):number {
 const started = Date.parse(createdAt);
 return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}
/** `12s`, `3m 20s`, `2h 5m`: compact, and stable for the 1 s tick. */
export function formatUptime(ms:number):string {
 const seconds = Math.floor(Math.max(0, ms) / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
 if (hours > 0) return `${hours}h ${minutes % 60}m`;
 if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
 return `${seconds}s`;
}

/** The explicit "Set as current" choices, kept in renderer memory per (project, worktree) and never persisted. */
export type RunCurrentConfigs = { get:(scope:RunScope) => RunEntryRef|undefined; choose:(scope:RunScope, entry:RunEntryRef) => void; forget:(scope:RunScope) => void };
const scopeKey = (scope:RunScope) => `${scope.projectId}\0${canonicalScopePath(scope.root) ?? scope.root}`;
export function createRunCurrentConfigs():RunCurrentConfigs {
 const chosen = new Map<string,RunEntryRef>();
 return {
  get:scope => chosen.get(scopeKey(scope)),
  choose:(scope, entry) => { chosen.set(scopeKey(scope), entry); },
  forget:scope => { chosen.delete(scopeKey(scope)); },
 };
}
export const runCurrentConfigs = createRunCurrentConfigs();

/** The entry last run from this worktree, which is what "current configuration" means until one is chosen by hand. */
export function lastRunEntry(scope:RunScope, sessions:readonly Session[]):RunEntryRef|undefined {
 const latest = sessions
  .filter(session => session.projectId === scope.projectId && session.run && sameCanonicalScope(session.worktreePath, scope.root))
  .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.updatedAt.localeCompare(left.updatedAt))[0];
 return latest?.run ? entryRefOf(latest.run.commandId, latest.run.name) : undefined;
}
/** A chosen entry wins; otherwise the worktree's most recent run. */
export function currentRunEntry(scope:RunScope, sessions:readonly Session[], chosen:RunEntryRef|undefined):RunEntryRef|undefined {
 return chosen ?? lastRunEntry(scope, sessions);
}

export type RunKeyAction = 'run'|'stop'|'restart';
/** Ctrl+F5 runs the current configuration, Shift+F5 stops it, Ctrl+Shift+F5 restarts it. */
export function runKeyAction(event:{key:string;ctrlKey?:boolean;shiftKey?:boolean;altKey?:boolean;metaKey?:boolean}):RunKeyAction|undefined {
 if (event.key !== 'F5' || event.altKey || event.metaKey) return undefined;
 if (event.ctrlKey && event.shiftKey) return 'restart';
 if (event.ctrlKey) return 'run';
 if (event.shiftKey) return 'stop';
 return undefined;
}
export const RUN_SHORTCUTS:Record<RunKeyAction,string> = { run:'Control+F5', stop:'Shift+F5', restart:'Control+Shift+F5' };
/** The Run command a workbench's F5 keys send to its Run view, or undefined: never from a terminal, an editor, an input
 * or a modal dialog. The host shows the Run view, which acts on its current configuration. */
export function runKeyCommand(event:KeyboardEvent):RunCommandRequest|undefined {
 const current = runKeyAction(event);
 if (!current || (event.target as Element|null)?.closest?.('.xterm, [role="dialog"][aria-modal="true"]') || isKeyboardEditableTarget(event.target)) return undefined;
 return { key:crypto.randomUUID(), current };
}
export const runShortcutLabel = (action:RunKeyAction) => RUN_SHORTCUTS[action].replace('Control+', 'Ctrl+');

/** Entries matching a name, command or group fragment; the filter box appears past `RUN_FILTER_FROM` entries. */
export const RUN_FILTER_FROM = 9;
export function filterRunEntries<T extends {name:string;command:string;detail?:string}>(entries:readonly T[], query:string):T[] {
 const needle = query.trim().toLowerCase();
 if (!needle) return [...entries];
 return entries.filter(entry => `${entry.name} ${entry.command} ${entry.detail ?? ''}`.toLowerCase().includes(needle));
}

/** At most 20 palette rows for the current worktree: saved commands first, then detected entries. */
export const PALETTE_RUN_LIMIT = 20;
export type PaletteRunEntry = { id:string; name:string; detail:string; commandId?:string; detectedKey?:string };
export function paletteRunEntries(entries:readonly {name:string;command:string;commandId:string;source:'saved'|'detected';detail?:string}[], limit = PALETTE_RUN_LIMIT):PaletteRunEntry[] {
 const seen = new Set<string>();
 const rows:PaletteRunEntry[] = [];
 for (const entry of entries) {
  const id = entry.source === 'detected' ? `detected:${detectedKeyOf(entry.commandId) ?? entry.commandId}` : `saved:${entry.commandId}`;
  if (seen.has(id) || rows.length >= limit) continue;
  seen.add(id);
  rows.push({
   id,
   name:entry.name,
   detail:entry.detail ?? entry.command,
   ...(entry.source === 'detected' ? { detectedKey:detectedKeyOf(entry.commandId) ?? entry.commandId } : { commandId:entry.commandId }),
  });
 }
 return rows;
}
