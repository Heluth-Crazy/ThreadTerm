import { useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "@threadterm/protocol";
import { isActionableInboxItem } from "../inboxVisibility";
import { request } from "../bridge";
import { displayPath, sameCanonicalScope } from "../projectScope";
import { orderedPaletteSessions, paletteOrder, paletteSessionDetail, paletteSessionState } from "../paletteSessions";
import type { SessionViewState } from "../sessionState";
import { AgentIcon } from "./PrototypeIcon";
import { useTranslation } from "../i18n";
import { paletteKeyAction } from "../paletteKeys";
import { useModalFocus } from "../useModalFocus";
import type { GitWorkbenchAction } from "../workbench/gitKeyboardCommand";
import { captureGitPaletteHost, captureRunPaletteHost } from "../workbench/gitPaletteHost";
import { WbIcon } from "../workbench/icons";
import { isActiveRun, paletteRunEntries, type PaletteRunEntry } from "../workbench/runView";
import "./command-palette.css";

type Props = { data: Snapshot; onClose: () => void; onSession: (id: string) => void; onProject: (id: string) => void; onCreate: () => void; onCreateGroup: () => void; onAll: () => void; onInbox: () => void; onSettings: () => void; onUsage?: () => void; workbench?: boolean };
type Entry = { id: string; group: string; label: string; detail: string; icon: string; run: () => void; provider?: string; tone?: SessionViewState; disabledReason?:string };
export function CommandPalette({ data, onClose, onSession, onProject, onCreate, onCreateGroup, onAll, onInbox, onSettings, onUsage, workbench = false }: Props) {
  const { locale } = useTranslation(); const zh = locale === "zh-CN"; const copy = (en: string, cn: string) => zh ? cn : en;
  const [query, setQuery] = useState(""); const [active, setActive] = useState(0); const input = useRef<HTMLInputElement>(null); const panel = useRef<HTMLElement>(null);
  useModalFocus(panel, onClose);
  // Captured once: activity changes while the palette is open must not move rows under the pointer or keyboard.
  const [order] = useState(() => paletteOrder(data.sessions));
  const externalHost=document.querySelector<HTMLElement>('[data-external-files]');
  const externalDisabledReason=externalHost?externalHost.dataset.externalDisabledReason:copy('Open a Chat workspace first.','请先打开聊天工作区。');
  const [gitHost]=useState(()=>captureGitPaletteHost(document));
  const gitDisabledReason=gitHost?.repository?undefined:gitHost?copy('Open a workspace with a Git repository first.','请先打开包含 Git 仓库的工作区。'):copy('Focus a Git workspace or open its Files and changes dialog first.','请先聚焦 Git 工作区，或打开其文件和更改对话框。');
  // The Run entries belong to one captured worktree and reach only it, exactly like the Git host above.
  const [runHost]=useState(()=>captureRunPaletteHost(document));
  const runDisabledReason=runHost?undefined:copy('Focus a workspace with the Run view first.','请先聚焦包含运行视图的工作区。');
  const [runEntries,setRunEntries]=useState<PaletteRunEntry[]>([]);
  useEffect(()=>{
    if(!workbench||!runHost)return;
    let live=true;const {projectId,root}=runHost;
    void Promise.all([request('quickLaunch.list',{projectId}),request('quickLaunch.detect',{projectId,cwd:root})])
      .then(([commands,detection])=>{if(!live)return;setRunEntries(paletteRunEntries([
        ...commands.map(command=>({name:command.name,command:command.command,commandId:command.id,source:'saved' as const})),
        ...detection.entries.map(entry=>({name:entry.name,command:entry.command,commandId:`detected:${entry.key}`,source:'detected' as const})),
      ]));})
      .catch(()=>{});
    return()=>{live=false;};
  },[workbench,runHost]);
  const runActive=runHost?data.sessions.filter(session=>isActiveRun(session)&&sameCanonicalScope(session.worktreePath,runHost.root)).length:0;
  const runEntry=(target:{commandId?:string;detectedKey?:string;stopAll?:boolean},label:string,detail:string,icon:string,disabled=false):Entry=>{
    const reason=runDisabledReason??(disabled?detail:undefined);
    return { id:`run:${target.commandId??target.detectedKey??'stop-all'}`, group:copy('Run','运行'), label, detail:reason??detail, icon, disabledReason:reason, run:()=>{ if(reason||!runHost?.element.isConnected)return; const key=crypto.randomUUID(); dispatchEvent(new CustomEvent('threadterm:workbench',{detail:{view:'run',key,hostKey:runHost.key,run:{key,...target}}})); } };
  };
  const workbenchEntry = (view: string, label: string, detail: string, icon: string): Entry => ({ id:`workbench:${view}`, group:copy("Workspace", "工作区"), label, detail, icon, run:() => dispatchEvent(new CustomEvent("threadterm:workbench", { detail:{ view } })) });
  const gitEntry = (action:GitWorkbenchAction, label:string, detail:string, icon:string):Entry => ({id:`git:${action}`,group:copy('Git','Git'),label,detail:gitDisabledReason??detail,icon,disabledReason:gitDisabledReason,run:()=>{if(!gitDisabledReason&&gitHost?.element.isConnected)dispatchEvent(new CustomEvent('threadterm:workbench',{detail:{view:'scm',key:crypto.randomUUID(),action,hostKey:gitHost.key}}));}});
  const entries = useMemo<Entry[]>(() => [
    ...(workbench ? [
      workbenchEntry("quick-open", copy("Go to file…", "转到文件…"), "Ctrl+P", "file"),
      {...workbenchEntry("external-files", copy("Open file outside workspace…", "打开工作区外的文件…"), externalDisabledReason??"Ctrl+O", "popout"),disabledReason:externalDisabledReason,run:()=>{if(!externalDisabledReason)dispatchEvent(new CustomEvent('threadterm:workbench',{detail:{view:'external-files'}}));}},
      workbenchEntry("search", copy("Search in files", "在文件中搜索"), "Ctrl+Shift+F", "search"),
      workbenchEntry("scm", copy("Source Control", "源代码管理"), "Ctrl+Shift+G", "branch"),
      workbenchEntry("changes", copy("Agent changes", "Agent 改动"), copy("Review changes since checkpoints", "审查检查点以来的改动"), "spark"),
    ] : []),
    gitEntry('commit',copy('Git: Commit…','Git：提交…'),copy('Focus the commit message','聚焦提交说明'),'check'),
    gitEntry('pull',copy('Git: Pull','Git：拉取'),copy('Pull from the tracked branch','从跟踪分支拉取'),'branch'),
    gitEntry('push',copy('Git: Push','Git：推送'),copy('Push to the tracked branch','推送到跟踪分支'),'export'),
    gitEntry('fetch',copy('Git: Fetch','Git：获取'),copy('Fetch remote changes','获取远程更改'),'branch'),
    gitEntry('switch-branch',copy('Git: Switch branch…','Git：切换分支…'),copy('Filter branches','筛选分支'),'branch'),
    gitEntry('stash',copy('Git: Stash changes…','Git：暂存更改…'),copy('Save changes without committing','保存更改但不提交'),'archive'),
    ...(workbench?[runEntry({stopAll:true},copy('Run: Stop all in this worktree','运行：停止此工作树中的所有运行'),runActive?`${runActive} ${copy('active','运行中')}`:copy('No run is active in this worktree.','此工作树没有运行中的进程。'),'stop',runActive===0),...runEntries.map(entry=>runEntry(entry.commandId?{commandId:entry.commandId}:{detectedKey:entry.detectedKey},`${copy('Run','运行')}: ${entry.name}`,entry.detail,'play'))]:[]),
    { id:"new", group:copy("Actions", "动作"), label:copy("New terminal", "新建终端"), detail:copy("Create a session", "创建后直达会话"), icon:"plus", run:onCreate }, { id:"new-group", group:copy("Actions", "动作"), label:copy("New group chat…", "新建群聊…"), detail:copy("Work with several agents", "与多个智能体协作"), icon:"agents", run:onCreateGroup }, { id:"all", group:copy("Actions", "动作"), label:copy("All terminals", "打开所有终端"), detail:copy("Browse sessions", "查找会话与记录"), icon:"terminal", run:onAll }, { id:"usage", group:copy("Actions", "动作"), label:copy("Open usage", "打开用量"), detail:copy("Tokens, cost and activity", "Token、费用与活动"), icon:"layers", run:() => onUsage?.() }, { id:"inbox", group:copy("Actions", "动作"), label:copy("Open inbox", "打开待处理队列"), detail:copy(`${data.inbox.filter(item => isActionableInboxItem(item)).length} unread`, `${data.inbox.filter(item => isActionableInboxItem(item)).length} 项`), icon:"inbox", run:onInbox }, { id:"settings", group:copy("Actions", "动作"), label:copy("Settings", "设置"), detail:copy("Local preferences", "本地偏好"), icon:"gear", run:onSettings },
    ...data.projects.map(project => ({ id:`project:${project.id}`, group:copy("Projects", "项目"), label:project.name, detail:`${displayPath(project.path)} · ${copy("Project overview", "项目总览")}`, icon:"folder", run:() => onProject(project.id) })),
    ...orderedPaletteSessions(data.sessions, order).map(session => ({ id:`session:${session.id}`, group:copy("Sessions", "会话"), label:session.title, detail:paletteSessionDetail(session, data.projects, zh, data.providers), icon:"terminal", provider:session.provider, tone:paletteSessionState(session, zh).tone, run:() => onSession(session.id) })),
  ], [copy, data, onAll, onCreate, onCreateGroup, onInbox, onProject, onSession, onSettings, onUsage, order, workbench, zh, runEntries, runActive, runDisabledReason, runHost]);
  const matches = entries.filter(entry => `${entry.label} ${entry.detail} ${entry.group}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { input.current?.focus(); }, []); useEffect(() => setActive(0), [query]);
  useEffect(() => { const key = (event: KeyboardEvent) => { const action = paletteKeyAction(event); if (!action) return; if (action === "run" && event.target instanceof Element && event.target.closest(".cmd-row")) return; event.preventDefault(); if (action === "ignore") return; if (action === "close") { onClose(); return; } if (action === "next") { setActive(value => Math.min(value + 1, Math.max(0, matches.length - 1))); return; } if (action === "previous") { setActive(value => Math.max(0, value - 1)); return; } if (matches[active] && !matches[active].disabledReason) { matches[active].run(); onClose(); } }; addEventListener("keydown", key); return () => removeEventListener("keydown", key); }, [active, matches, onClose]);
  let index = -1, lastGroup = "";
  return <div className="scrim shell-palette-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={panel} tabIndex={-1} className="dialog palette" role="dialog" aria-modal="true" aria-label={copy("Command palette", "命令面板")}><input ref={input} className="palette-input" value={query} onChange={event => setQuery(event.target.value)} placeholder={copy("Search commands, projects, sessions, or switch terminals…", "搜索命令、项目、会话，或切换终端…")} /> <div className="palette-results">{matches.map(entry => { const currentIndex = ++index; const group = entry.group !== lastGroup ? (lastGroup = entry.group) : ""; return <div key={entry.id}>{group && <div className="cmd-group">{group}</div>}<button className={`cmd-row${currentIndex === active ? " active" : ""}`} disabled={!!entry.disabledReason} title={entry.disabledReason} onMouseEnter={() => setActive(currentIndex)} onClick={() => { entry.run(); onClose(); }}>{entry.provider ? <AgentIcon provider={entry.provider} /> : <WbIcon name={entry.icon} />}<b>{entry.label}</b><span>{entry.tone && <i className={`dot st-${entry.tone}`} aria-hidden="true" />}{entry.detail}</span></button></div>; })}{!matches.length && <p className="palette-empty">{copy("No matching commands. Try a project or session name.", "没有匹配命令。试试项目名或会话名。")}</p>}</div><footer className="palette-foot"><span>{copy("↑ ↓ Select", "↑ ↓ 选择")}</span><span>{copy("Enter Open", "Enter 打开")}</span><span>{copy("Esc Close", "Esc 关闭")}</span></footer></section></div>;
}
