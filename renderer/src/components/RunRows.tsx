import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DetectedRunEntry, QuickLaunchCommand, QuickLaunchKind, QuickLaunchRepoCatalog, QuickLaunchRepoEntry, Session } from '@threadterm/protocol';
import { request, subscribeEvents } from '../bridge';
import { sameCanonicalScope } from '../projectScope';
import { activeRun, missingToolLabel, previewWaitingLabel, quickLaunchError, runState, suggestedTag } from '../quickLaunch';
import { detectedCommandId, agentStartLabel, startedByChat } from '../workbench/runView';
import { Icon } from './PrototypeIcon';

/** The Run glyph: the approved play triangle, shared by the popover, the view and the palette icon. */
export const Play = () => <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>;

/** One launchable row. Detected and repo entries name only an id; launch text always comes from a fresh file read. */
export type RunEntry = {
 key:string;
 /** The `run.commandId` this entry records: a saved id, `detected:<key>`, or `repo:<id>`. */
 commandId:string;
 source:'saved'|'detected'|'repo';
 name:string;
 command:string;
 kind:QuickLaunchKind;
 cwd:string;
 sourceLabel?:string;
 group?:string;
 missingTool?:string;
 disabledReason?:string;
 saved?:QuickLaunchCommand;
 detected?:DetectedRunEntry;
 repo?:QuickLaunchRepoEntry;
};
export const savedRunEntry = (command:QuickLaunchCommand):RunEntry => ({ key:command.id, commandId:command.id, source:'saved', name:command.name, command:command.command, kind:command.kind, cwd:command.cwd, saved:command });
export const detectedRunEntry = (entry:DetectedRunEntry):RunEntry => ({ key:entry.key, commandId:detectedCommandId(entry.key), source:'detected', name:entry.name, command:entry.command, kind:entry.kind, cwd:entry.cwd, sourceLabel:entry.source.label, group:entry.group, missingTool:entry.missingTool, detected:entry });
export const repoRunEntry = (entry:QuickLaunchRepoEntry):RunEntry => ({ key:entry.id, commandId:`repo:${entry.id}`, source:'repo', name:entry.name, command:entry.command, kind:entry.kind, cwd:entry.cwd, sourceLabel:'.threadterm/run.json', disabledReason:entry.missingSecrets.length ? `Needs ${entry.missingSecrets[0]}` : undefined, repo:entry });
export const savedRunEntries = (commands:readonly QuickLaunchCommand[]) => commands.map(savedRunEntry);
export const detectedRunEntries = (entries:readonly DetectedRunEntry[]) => entries.map(detectedRunEntry);
export const repoRunEntries = (entries:readonly QuickLaunchRepoEntry[]) => entries.map(repoRunEntry);

/** A pinned command replaces its detected twin only when it launches exactly the same thing. */
export function isPinnedDetectedTwin(command:Pick<QuickLaunchCommand,'command'|'cwd'|'shell'>, entry:Pick<DetectedRunEntry,'command'|'cwd'|'shell'>) {
 return command.command === entry.command && command.cwd === entry.cwd && command.shell === entry.shell;
}
/** Removing a plain pin is safe when its detected source preserves the whole launch definition. */
export function unpinNeedsConfirm(command:Pick<QuickLaunchCommand,'name'|'kind'|'env'|'previewUrl'|'dependsOn'|'command'|'cwd'|'shell'>, detected?:Pick<DetectedRunEntry,'name'|'kind'|'command'|'cwd'|'shell'>) {
 return !detected || command.name !== detected.name || command.kind !== detected.kind || !isPinnedDetectedTwin(command, detected) || command.env.length > 0 || Boolean(command.previewUrl) || Boolean(command.dependsOn?.length);
}

/** The active run and the latest run of one entry in one worktree, resolved exactly as admission defines them. */
export function runEntrySessions(sessions:readonly Session[], commandId:string, root:string):{active?:Session;latest?:Session} {
 const scoped = sessions.filter(session => session.run?.commandId === commandId && !session.archived && !session.readOnly && sameCanonicalScope(session.worktreePath, root));
 const latest = [...scoped].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.updatedAt.localeCompare(left.updatedAt))[0];
 return { active:activeRun(scoped, commandId, root), latest };
}

/** The URL a run printed or listened on, opening the existing preview surface. While a service run is
 * still being watched, its configured fallback is shown but cannot be opened yet. */
export function RunUrlLink({url, compact, onOpenPreview, pending, zh}:{url:string;compact?:boolean;onOpenPreview?:(url:string) => void;pending?:boolean;zh?:boolean}) {
 const port=compact?url.match(/^https?:\/\/[^/]+:(\d+)(?:\/|$)/)?.[1]:undefined;
 const text=port?<span data-testid="run-port">:{port}</span>:url;
 if (!onOpenPreview) return <code className="ql-url-text" title={url}>{text}</code>;
 if (pending) return <span className="ql-url is-pending" data-testid="run-url" data-pending="true" aria-disabled="true" title={previewWaitingLabel(Boolean(zh))}>{text}</span>;
 return <a className="ql-url" data-testid="run-url" href={url} title={url} onClick={event => { event.preventDefault(); onOpenPreview(url); }}>{text}</a>;
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

/** One dense entry row. The output affordance stays distinct from starting a run. */
export function RunEntryRow({entry, session, latest, zh, busy, current, details, actions, onOpen, onRun, sequenceText, onCancelSequence}:{
 entry:RunEntry;session?:Session;latest?:Session;zh:boolean;busy?:boolean;current?:boolean;
 sequenceText?:string;onCancelSequence?:()=>void;details?:ReactNode;actions:ReactNode;onOpen?:(id:string)=>void;onRun?:()=>void;
}) {
 const copy=(en:string,cn:string)=>zh?cn:en;
 const view = session ? runState(session) : undefined;
 const last = latest ? runState(latest) : undefined;
 const missing = entry.missingTool ? missingToolLabel(entry.missingTool, zh) : entry.repo?.missingSecrets.length ? (zh ? `需要 ${entry.repo.missingSecrets[0]}` : `Needs ${entry.repo.missingSecrets[0]}`) : entry.disabledReason;
 const suggested = suggestedTag(entry.detected, zh);
 return <section className={`wb-run-row${entry.source === 'detected' ? ' ql-detected-entry' : ''}${missing ? ' is-missing' : ''}${current ? ' is-current' : ''}`}
  data-testid={entry.source === 'saved' ? `quick-launch-command-${entry.key}` : entry.source === 'repo' ? `quick-launch-repo-entry-${entry.key}` : `quick-launch-detected-entry-${entry.key}`}
  data-run-entry={entry.commandId} data-current={current ? 'true' : undefined} aria-label={entry.name} title={missing}
  onDoubleClick={event => { if (!session && !missing) { event.preventDefault();onRun?.(); } }} onKeyDown={event=>{if(event.key==='Enter'&&!session&&!missing&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&(event.target===event.currentTarget||Boolean((event.target as HTMLElement).closest('[data-run-primary],.wb-run-row-name')))){event.preventDefault();onRun?.();}}}>
  {session?<button type="button" className={`icon-btn wb-run-row-play ql-state ql-${view!.state}`} data-run-primary="true" aria-label={copy('Open output','打开输出')} title={copy('Open output','打开输出')} onClick={()=>onOpen?.(session.id)}><span className="dot" aria-hidden="true"/></button>
   :last?.state==='failed'?<button type="button" className="icon-btn wb-run-row-play ql-failed" data-run-primary="true" aria-label={zh?`显示输出（退出码 ${last.exitCode ?? ''}）`:`Show output (exit ${last.exitCode ?? ''})`} title={zh?`显示输出（退出码 ${last.exitCode ?? ''}）`:`Show output (exit ${last.exitCode ?? ''})`} onClick={()=>onOpen?.(latest!.id)}>×</button>
   :<button type="button" className="icon-btn wb-run-row-play" data-run-primary="true" aria-label={`${zh?'运行':'Run'} ${entry.name}`} title={`${zh?'运行':'Run'} ${entry.name}`} disabled={busy || Boolean(missing)} onClick={() => onRun?.()}><Play/></button>}
  {session ? <button type="button" className={`wb-run-row-name ql-${view!.state}`} onClick={() => onOpen?.(session.id)} title={entry.name}><strong>{entry.name}</strong></button>
   : <span className="wb-run-row-name" title={entry.name}><strong>{entry.name}</strong>{suggested&&<span className="ql-source-label ql-suggested" data-suggested="true" title={suggested.title}>{suggested.label}</span>}</span>}
  {sequenceText?<span className="wb-run-sequence" data-testid="run-sequence-chip" title={sequenceText}><span>{sequenceText}</span>{onCancelSequence&&<button type="button" className="wb-run-row-name" disabled={busy} onClick={onCancelSequence}>{copy('Cancel','取消')}</button>}</span>:<code title={entry.command}>{entry.command}</code>}{details}<span className="wb-run-row-actions">{actions}</span>
 </section>;
}

export type RunCatalog = { commands:QuickLaunchCommand[]; detected:DetectedRunEntry[]; repo:QuickLaunchRepoCatalog; truncated:boolean; loading:boolean; detecting:boolean; repoLoading:boolean; issue?:string; refresh:() => void };

/** Commands must wait for all three catalog sources: a repo entry can be the user's current configuration. */
export const runCatalogReady = (catalog:Pick<RunCatalog,'loading'|'detecting'|'repoLoading'>) => !catalog.loading && !catalog.detecting && !catalog.repoLoading;

/** Saved, detected and repo entries of one worktree, read only while the surface is live. All reads are generation-fenced;
 * focus and visibility re-read file-backed entries, and no file watcher or polling is added. */
export function useRunCatalog({projectId, root, live, zh, sessionIds}:{projectId:string;root:string;live:boolean;zh:boolean;sessionIds:ReadonlySet<string>}):RunCatalog {
 const [commands, setCommands] = useState<QuickLaunchCommand[]>([]);
 const [detected, setDetected] = useState<DetectedRunEntry[]>([]);
 const [repo, setRepo] = useState<QuickLaunchRepoCatalog>({exists:false,entries:[]});
 const [truncated, setTruncated] = useState(false);
 const [loading, setLoading] = useState(true), [detecting, setDetecting] = useState(true), [repoLoading, setRepoLoading] = useState(true);
 const [issue, setIssue] = useState<string>();
 const listGeneration = useRef(0), detectGeneration = useRef(0), repoGeneration = useRef(0);
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
 const readRepo = useCallback(async () => {
  const token = ++repoGeneration.current;
  setRepoLoading(true);
  try { const value = await request('quickLaunch.repo.list', {projectId, cwd:root}); if (token === repoGeneration.current) { setRepo(value); if (value.error) setIssue(quickLaunchError(value.error, zh)); else setIssue(undefined); } return value; }
  catch (error) { if (token === repoGeneration.current) setIssue(quickLaunchError(error, zh)); throw error; }
  finally { if (token === repoGeneration.current) setRepoLoading(false); }
 }, [projectId, root, zh]);
 const refresh = useCallback(() => { setIssue(undefined); void load().catch(() => {}); void detect().catch(() => {}); void readRepo().catch(() => {}); }, [load, detect, readRepo]);
 useEffect(() => {
  setCommands([]); setDetected([]); setRepo({exists:false,entries:[]}); setTruncated(false); setIssue(undefined); setLoading(true); setDetecting(true); setRepoLoading(true);
  return () => { listGeneration.current++; detectGeneration.current++; repoGeneration.current++; };
 }, [projectId, root]);
 useEffect(() => {
  if (!live) return;
  refresh();
  const unsubscribe = subscribeEvents(event => {
   if (event.event !== 'state.changed') return;
   const data = event.data as {kind?:unknown;sessionId?:unknown}|undefined, kind = String(data?.kind ?? '');
   if (kind === 'quickLaunch.commands' || kind === 'quickLaunch.setup' || kind === 'quickLaunch.repo') refresh();
   else if (kind === 'session.run' && ids.current.has(String(data?.sessionId ?? ''))) void detect().catch(() => {});
  });
  const focus = () => { if (document.visibilityState === 'visible') { void detect().catch(() => {}); void readRepo().catch(() => {}); } };
  const visibility = () => { if (document.visibilityState === 'visible') focus(); };
  addEventListener('focus', focus); document.addEventListener('visibilitychange', visibility);
  return () => { listGeneration.current++; detectGeneration.current++; repoGeneration.current++; unsubscribe(); removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visibility); };
 }, [live, refresh, detect, readRepo]);
 return { commands, detected, repo, truncated, loading, detecting, repoLoading, issue, refresh };
}
