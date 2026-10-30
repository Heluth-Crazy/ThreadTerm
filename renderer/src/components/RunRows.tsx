import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DetectedRunEntry, QuickLaunchCommand, QuickLaunchKind, Session } from '@threadterm/protocol';
import { request, subscribeEvents } from '../bridge';
import { sameCanonicalScope } from '../projectScope';
import { activeRun, missingToolLabel, previewWaitingLabel, quickLaunchError, runState, runStateLabel, suggestedTag } from '../quickLaunch';
import { detectedCommandId, agentStartLabel, startedByChat } from '../workbench/runView';
import { Icon } from './PrototypeIcon';

/** The Run glyph: the approved play triangle, shared by the popover, the view and the palette icon. */
export const Play = () => <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>;

/** One launchable row, from either source. A detected entry carries no trusted command text beyond what detection
 * returned; a run names only its `detected:<key>`. */
export type RunEntry = {
 key:string;
 /** The `run.commandId` this entry records: a saved id, or `detected:<key>`. */
 commandId:string;
 source:'saved'|'detected';
 name:string;
 command:string;
 kind:QuickLaunchKind;
 cwd:string;
 sourceLabel?:string;
 group?:string;
 missingTool?:string;
 saved?:QuickLaunchCommand;
 detected?:DetectedRunEntry;
};
export const savedRunEntry = (command:QuickLaunchCommand):RunEntry => ({ key:command.id, commandId:command.id, source:'saved', name:command.name, command:command.command, kind:command.kind, cwd:command.cwd, saved:command });
export const detectedRunEntry = (entry:DetectedRunEntry):RunEntry => ({ key:entry.key, commandId:detectedCommandId(entry.key), source:'detected', name:entry.name, command:entry.command, kind:entry.kind, cwd:entry.cwd, sourceLabel:entry.source.label, group:entry.group, missingTool:entry.missingTool, detected:entry });
export const savedRunEntries = (commands:readonly QuickLaunchCommand[]) => commands.map(savedRunEntry);
export const detectedRunEntries = (entries:readonly DetectedRunEntry[]) => entries.map(detectedRunEntry);

/** The active run and the latest run of one entry in one worktree, resolved exactly as admission defines them. */
export function runEntrySessions(sessions:readonly Session[], commandId:string, root:string):{active?:Session;latest?:Session} {
 const scoped = sessions.filter(session => session.run?.commandId === commandId && !session.archived && !session.readOnly && sameCanonicalScope(session.worktreePath, root));
 const latest = [...scoped].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.updatedAt.localeCompare(left.updatedAt))[0];
 return { active:activeRun(scoped, commandId, root), latest };
}

/** The URL a run printed or listened on, opening the existing preview surface. While a service run is
 * still being watched, its configured fallback is shown but cannot be opened yet. */
export function RunUrlLink({url, onOpenPreview, pending, zh}:{url:string;onOpenPreview?:(url:string) => void;pending?:boolean;zh?:boolean}) {
 if (!onOpenPreview) return <code className="ql-url-text">{url}</code>;
 if (pending) return <span className="ql-url is-pending" data-testid="run-url" data-pending="true" aria-disabled="true" title={previewWaitingLabel(Boolean(zh))}>{url}</span>;
 return <a className="ql-url" data-testid="run-url" href={url} title={url} onClick={event => { event.preventDefault(); onOpenPreview(url); }}>{url}</a>;
}

/** A run started by an agent's chat: a small "Agent" tag whose tooltip names the chat and whose click focuses it. */
export function AgentTag({startedBy, sessions, zh, onOpen}:{startedBy?:string;sessions:readonly Session[];zh:boolean;onOpen?:(id:string) => void}) {
 const label = agentStartLabel(startedBy, sessions, zh), chat = startedByChat(startedBy, sessions);
 if (!label) return null;
 const text = zh ? '代理' : 'Agent';
 return chat && onOpen
  ? <button type="button" className="ql-agent-tag" data-testid="run-agent-tag" title={label} aria-label={label} onClick={() => onOpen(chat.id)}>{text}</button>
  : <span className="ql-agent-tag" data-testid="run-agent-tag" title={label}>{text}</span>;
}

/** The shared row: identity, command text, run state and URL. Each surface adds its own actions, so the popover keeps
 * its compact launcher buttons and the Run view adds Restart, Stop and Set as current without a second row renderer. */
export function RunEntryRow({entry, session, zh, busy, worktree, uptime, current, agentLabel, actions, sequenceText, onCancelSequence}:{
 entry:RunEntry;
 session?:Session;
 zh:boolean;
 busy?:boolean;
 worktree?:string;
 uptime?:string;
 current?:boolean;
 /** The Agent tag's tooltip for this entry's active run, when an agent started it. */
 agentLabel?:string;
 actions:ReactNode;
 sequenceText?:string;
 onCancelSequence?:()=>void;
}) {
 const view = session ? runState(session) : undefined;
 const missing = entry.missingTool ? missingToolLabel(entry.missingTool, zh) : undefined;
 const suggested = suggestedTag(entry.detected, zh);
 return <section className={`ql-command${entry.source === 'detected' ? ' ql-detected-entry' : ''}${missing ? ' is-missing' : ''}${current ? ' is-current' : ''}`}
  data-testid={entry.source === 'saved' ? `quick-launch-command-${entry.key}` : `quick-launch-detected-entry-${entry.key}`}
  data-run-entry={entry.commandId} data-current={current ? 'true' : undefined} aria-label={entry.name} title={missing}>
  <div className="ql-command-head">
   <strong>{entry.name}</strong>
   {entry.sourceLabel && <span className="ql-source-label">{entry.sourceLabel}</span>}
   {suggested && <span className="ql-source-label ql-suggested" data-suggested="true" title={suggested.title}>{suggested.label}</span>}
   {worktree && <span className="ql-worktree" title={worktree}>{worktree}</span>}
   {view && <span className={`ql-state ql-${view.state}`} title={agentLabel}><span className="dot" aria-hidden="true"/>{runStateLabel(view, zh)}</span>}
   {uptime && <span className="ql-uptime">{uptime}</span>}
   {missing && <span className="ql-missing-tool">{missing}</span>}
   {sequenceText && <span className="ql-sequence-chip" data-testid="run-sequence-chip">{sequenceText}{onCancelSequence&&<button type="button" className="btn btn-sm btn-ghost" aria-label={zh?'取消启动序列':'Cancel starting sequence'} disabled={busy} onClick={onCancelSequence}>{zh?'取消':'Cancel'}</button>}</span>}
  </div>
  <code title={entry.command}>{entry.command}</code>
  <div className="ql-actions" data-busy={busy ? 'true' : undefined}>{actions}</div>
 </section>;
}

export type RunCatalog = { commands:QuickLaunchCommand[]; detected:DetectedRunEntry[]; truncated:boolean; loading:boolean; detecting:boolean; issue?:string; refresh:() => void };

/** Saved commands and live detected entries of one worktree, read only while the surface is live: when it becomes live,
 * on a scope change, and on the runtime's own events. A closed popover never lists or detects. Every read is fenced by
 * its generation, so a slow answer for a previous worktree can never overwrite the current one; nothing polls. */
export function useRunCatalog({projectId, root, live, zh, sessionIds}:{projectId:string;root:string;live:boolean;zh:boolean;sessionIds:ReadonlySet<string>}):RunCatalog {
 const [commands, setCommands] = useState<QuickLaunchCommand[]>([]);
 const [detected, setDetected] = useState<DetectedRunEntry[]>([]);
 const [truncated, setTruncated] = useState(false);
 const [loading, setLoading] = useState(true), [detecting, setDetecting] = useState(true);
 const [issue, setIssue] = useState<string>();
 const listGeneration = useRef(0), detectGeneration = useRef(0);
 const ids = useRef(sessionIds); ids.current = sessionIds;
 const load = useCallback(async () => {
  const token = ++listGeneration.current;
  setLoading(true);
  try { const rows = await request('quickLaunch.list', {projectId}); if (token === listGeneration.current) setCommands(rows); return rows; }
  catch (error) { if (token === listGeneration.current) setIssue(quickLaunchError(error, zh)); throw error; }
  finally { if (token === listGeneration.current) setLoading(false); }
 }, [projectId, zh]);
 const detect = useCallback(async () => {
  const token = ++detectGeneration.current;
  setDetecting(true);
  try { const value = await request('quickLaunch.detect', {projectId, cwd:root}); if (token === detectGeneration.current) { setDetected(value.entries); setTruncated(value.truncated); } return value; }
  catch (error) { if (token === detectGeneration.current) setIssue(quickLaunchError(error, zh)); throw error; }
  finally { if (token === detectGeneration.current) setDetecting(false); }
 }, [projectId, root, zh]);
 const refresh = useCallback(() => { setIssue(undefined); void load().catch(() => {}); void detect().catch(() => {}); }, [load, detect]);
 useEffect(() => {
  setCommands([]); setDetected([]); setTruncated(false); setIssue(undefined); setLoading(true); setDetecting(true);
  return () => { listGeneration.current++; detectGeneration.current++; };
 }, [projectId, root]);
 useEffect(() => {
  if (!live) return;
  // Every time the surface becomes live, or its scope changes while live: it may have missed file changes.
  refresh();
  const unsubscribe = subscribeEvents(event => {
   if (event.event !== 'state.changed') return;
   const data = event.data as {kind?:unknown;sessionId?:unknown}|undefined, kind = String(data?.kind ?? '');
   if (kind === 'quickLaunch.commands' || kind === 'quickLaunch.setup') refresh();
   // A start or stop of one of this project's runs may have changed the files detection reads (a lockfile, a build).
   else if (kind === 'session.run' && ids.current.has(String(data?.sessionId ?? ''))) void detect().catch(() => {});
  });
  return () => { listGeneration.current++; detectGeneration.current++; unsubscribe(); };
 }, [live, refresh, detect]);
 return { commands, detected, truncated, loading, detecting, issue, refresh };
}

/** A runnable entry's primary button: run it, or open its existing terminal while it is active. */
export function RunEntryPrimary({entry, active, busy, zh, onRun, onOpen}:{entry:RunEntry;active?:Session;busy?:boolean;zh:boolean;onRun:() => void;onOpen:(id:string) => void}) {
 const missing = entry.missingTool ? missingToolLabel(entry.missingTool, zh) : undefined;
 return <button className="btn btn-sm" data-run-primary="true" disabled={busy || Boolean(missing)} title={missing} onClick={() => active ? onOpen(active.id) : onRun()}>{active ? <Icon name="terminal"/> : <Play/>}{active ? (zh ? '打开终端' : 'Open terminal') : (zh ? '运行' : 'Run')}</button>;
}
