import { useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "@threadterm/protocol";
import { isActionableInboxItem } from "../inboxVisibility";
import { displayPath } from "../projectScope";
import { AgentIcon, Icon } from "./PrototypeIcon";
import { useTranslation } from "../i18n";
import "./command-palette.css";

type Props = { data: Snapshot; onClose: () => void; onSession: (id: string) => void; onProject: (id: string) => void; onCreate: () => void; onAll: () => void; onInbox: () => void; onPresets: () => void; onSettings: () => void };
type Entry = { id: string; group: string; label: string; detail: string; icon: string; run: () => void };
export function CommandPalette({ data, onClose, onSession, onProject, onCreate, onAll, onInbox, onPresets, onSettings }: Props) {
  const { locale } = useTranslation(); const zh = locale === "zh-CN"; const copy = (en: string, cn: string) => zh ? cn : en;
  const [query, setQuery] = useState(""); const [active, setActive] = useState(0); const input = useRef<HTMLInputElement>(null);
  const entries = useMemo<Entry[]>(() => [
    { id:"new", group:copy("Actions", "动作"), label:copy("New terminal", "新建终端"), detail:copy("Create a session", "创建后直达会话"), icon:"plus", run:onCreate }, { id:"all", group:copy("Actions", "动作"), label:copy("All terminals", "打开所有终端"), detail:copy("Browse sessions", "查找会话与记录"), icon:"terminal", run:onAll }, { id:"inbox", group:copy("Actions", "动作"), label:copy("Open inbox", "打开待处理队列"), detail:copy(`${data.inbox.filter(item => isActionableInboxItem(item)).length} unread`, `${data.inbox.filter(item => isActionableInboxItem(item)).length} 项`), icon:"inbox", run:onInbox }, { id:"presets", group:copy("Actions", "动作"), label:copy("Work presets", "打开工作预设"), detail:copy("Saved layouts", "预览后恢复"), icon:"layers", run:onPresets }, { id:"settings", group:copy("Actions", "动作"), label:copy("Settings", "设置"), detail:copy("Local preferences", "本地偏好"), icon:"gear", run:onSettings },
    ...data.projects.map(project => ({ id:`project:${project.id}`, group:copy("Projects", "项目"), label:project.name, detail:`${displayPath(project.path)} · ${copy("Project overview", "项目总览")}`, icon:"folder", run:() => onProject(project.id) })),
    ...data.sessions.map(session => ({ id:`session:${session.id}`, group:copy("Sessions", "会话"), label:session.title, detail:`${session.provider} · ${session.status}`, icon:"terminal", run:() => onSession(session.id) })),
  ], [copy, data, onAll, onCreate, onInbox, onPresets, onProject, onSession, onSettings]);
  const matches = entries.filter(entry => `${entry.label} ${entry.detail} ${entry.group}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { input.current?.focus(); }, []); useEffect(() => setActive(0), [query]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } else if (event.key === "ArrowDown") { event.preventDefault(); setActive(value => Math.min(value + 1, Math.max(0, matches.length - 1))); } else if (event.key === "ArrowUp") { event.preventDefault(); setActive(value => Math.max(0, value - 1)); } else if (event.key === "Enter" && matches[active]) { event.preventDefault(); matches[active].run(); onClose(); } }; addEventListener("keydown", key); return () => removeEventListener("keydown", key); }, [active, matches, onClose]);
  let index = -1, lastGroup = "";
  return <div className="scrim shell-palette-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="dialog palette" role="dialog" aria-modal="true" aria-label={copy("Command palette", "命令面板")}><input ref={input} className="palette-input" value={query} onChange={event => setQuery(event.target.value)} placeholder={copy("Search commands, projects, sessions, or switch terminals…", "搜索命令、项目、会话，或切换终端…")} /> <div className="palette-results">{matches.map(entry => { const currentIndex = ++index; const group = entry.group !== lastGroup ? (lastGroup = entry.group) : ""; return <div key={entry.id}>{group && <div className="cmd-group">{group}</div>}<button className={`cmd-row${currentIndex === active ? " active" : ""}`} onMouseEnter={() => setActive(currentIndex)} onClick={() => { entry.run(); onClose(); }}>{entry.id.startsWith("session:") ? <AgentIcon provider={entry.detail.split(" · ")[0]} /> : <Icon name={entry.icon} />}<b>{entry.label}</b><span>{entry.detail}</span></button></div>; })}{!matches.length && <p className="palette-empty">{copy("No matching commands. Try a project or session name.", "没有匹配命令。试试项目名或会话名。")}</p>}</div><footer className="palette-foot"><span>{copy("↑ ↓ Select", "↑ ↓ 选择")}</span><span>{copy("Enter Open", "Enter 打开")}</span><span>{copy("Esc Close", "Esc 关闭")}</span></footer></section></div>;
}
