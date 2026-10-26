import { useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "@threadterm/protocol";
import { isActionableInboxItem } from "../inboxVisibility";
import { displayPath } from "../projectScope";
import { orderedPaletteSessions, paletteOrder, paletteSessionDetail, paletteSessionState } from "../paletteSessions";
import type { SessionViewState } from "../sessionState";
import { AgentIcon, Icon } from "./PrototypeIcon";
import { useTranslation } from "../i18n";
import { paletteKeyAction } from "../paletteKeys";
import { useModalFocus } from "../useModalFocus";
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
  const workbenchEntry = (view: string, label: string, detail: string, icon: string): Entry => ({ id:`workbench:${view}`, group:copy("Workspace", "工作区"), label, detail, icon, run:() => dispatchEvent(new CustomEvent("threadterm:workbench", { detail:{ view } })) });
  const entries = useMemo<Entry[]>(() => [
    ...(workbench ? [
      workbenchEntry("quick-open", copy("Go to file…", "转到文件…"), "Ctrl+P", "file"),
      {...workbenchEntry("external-files", copy("Open file outside workspace…", "打开工作区外的文件…"), externalDisabledReason??"Ctrl+O", "popout"),disabledReason:externalDisabledReason,run:()=>{if(!externalDisabledReason)dispatchEvent(new CustomEvent('threadterm:workbench',{detail:{view:'external-files'}}));}},
      workbenchEntry("search", copy("Search in files", "在文件中搜索"), "Ctrl+Shift+F", "search"),
      workbenchEntry("scm", copy("Source Control", "源代码管理"), "Ctrl+Shift+G", "branch"),
      workbenchEntry("changes", copy("Agent changes", "Agent 改动"), copy("Review changes since checkpoints", "审查检查点以来的改动"), "spark"),
    ] : []),
    { id:"new", group:copy("Actions", "动作"), label:copy("New terminal", "新建终端"), detail:copy("Create a session", "创建后直达会话"), icon:"plus", run:onCreate }, { id:"new-group", group:copy("Actions", "动作"), label:copy("New group chat…", "新建群聊…"), detail:copy("Work with several agents", "与多个智能体协作"), icon:"agents", run:onCreateGroup }, { id:"all", group:copy("Actions", "动作"), label:copy("All terminals", "打开所有终端"), detail:copy("Browse sessions", "查找会话与记录"), icon:"terminal", run:onAll }, { id:"usage", group:copy("Actions", "动作"), label:copy("Open usage", "打开用量"), detail:copy("Tokens, cost and activity", "Token、费用与活动"), icon:"layers", run:() => onUsage?.() }, { id:"inbox", group:copy("Actions", "动作"), label:copy("Open inbox", "打开待处理队列"), detail:copy(`${data.inbox.filter(item => isActionableInboxItem(item)).length} unread`, `${data.inbox.filter(item => isActionableInboxItem(item)).length} 项`), icon:"inbox", run:onInbox }, { id:"settings", group:copy("Actions", "动作"), label:copy("Settings", "设置"), detail:copy("Local preferences", "本地偏好"), icon:"gear", run:onSettings },
    ...data.projects.map(project => ({ id:`project:${project.id}`, group:copy("Projects", "项目"), label:project.name, detail:`${displayPath(project.path)} · ${copy("Project overview", "项目总览")}`, icon:"folder", run:() => onProject(project.id) })),
    ...orderedPaletteSessions(data.sessions, order).map(session => ({ id:`session:${session.id}`, group:copy("Sessions", "会话"), label:session.title, detail:paletteSessionDetail(session, data.projects, zh, data.providers), icon:"terminal", provider:session.provider, tone:paletteSessionState(session, zh).tone, run:() => onSession(session.id) })),
  ], [copy, data, onAll, onCreate, onCreateGroup, onInbox, onProject, onSession, onSettings, onUsage, order, workbench, zh]);
  const matches = entries.filter(entry => `${entry.label} ${entry.detail} ${entry.group}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { input.current?.focus(); }, []); useEffect(() => setActive(0), [query]);
  useEffect(() => { const key = (event: KeyboardEvent) => { const action = paletteKeyAction(event); if (!action) return; if (action === "run" && event.target instanceof Element && event.target.closest(".cmd-row")) return; event.preventDefault(); if (action === "ignore") return; if (action === "close") { onClose(); return; } if (action === "next") { setActive(value => Math.min(value + 1, Math.max(0, matches.length - 1))); return; } if (action === "previous") { setActive(value => Math.max(0, value - 1)); return; } if (matches[active] && !matches[active].disabledReason) { matches[active].run(); onClose(); } }; addEventListener("keydown", key); return () => removeEventListener("keydown", key); }, [active, matches, onClose]);
  let index = -1, lastGroup = "";
  return <div className="scrim shell-palette-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={panel} tabIndex={-1} className="dialog palette" role="dialog" aria-modal="true" aria-label={copy("Command palette", "命令面板")}><input ref={input} className="palette-input" value={query} onChange={event => setQuery(event.target.value)} placeholder={copy("Search commands, projects, sessions, or switch terminals…", "搜索命令、项目、会话，或切换终端…")} /> <div className="palette-results">{matches.map(entry => { const currentIndex = ++index; const group = entry.group !== lastGroup ? (lastGroup = entry.group) : ""; return <div key={entry.id}>{group && <div className="cmd-group">{group}</div>}<button className={`cmd-row${currentIndex === active ? " active" : ""}`} disabled={!!entry.disabledReason} title={entry.disabledReason} onMouseEnter={() => setActive(currentIndex)} onClick={() => { entry.run(); onClose(); }}>{entry.provider ? <AgentIcon provider={entry.provider} /> : <Icon name={entry.icon} />}<b>{entry.label}</b><span>{entry.tone && <i className={`dot st-${entry.tone}`} aria-hidden="true" />}{entry.detail}</span></button></div>; })}{!matches.length && <p className="palette-empty">{copy("No matching commands. Try a project or session name.", "没有匹配命令。试试项目名或会话名。")}</p>}</div><footer className="palette-foot"><span>{copy("↑ ↓ Select", "↑ ↓ 选择")}</span><span>{copy("Enter Open", "Enter 打开")}</span><span>{copy("Esc Close", "Esc 关闭")}</span></footer></section></div>;
}
