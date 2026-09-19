import { Select } from "./ui/Select";
import { useEffect, useMemo, useState } from "react";
import type { Preset, ProviderId, Session, Snapshot, Worktree } from "@threadterm/protocol";
import { request } from "../bridge";
import { sessionTime } from "../sessionTime";
import { AgentIcon, Icon } from "./PrototypeIcon";
import { isActionableInboxItem } from "../inboxVisibility";
import { displayPath } from "../projectScope";
import { workbenchAgents, type WorkbenchAgent } from "./workbenchAgents";
import "./workbench-page.css";

type Defaults = { projectId?: string; path?: string; provider?: ProviderId; title?: string };
type Props = { data: Snapshot; recentIds?: string[]; onProject: (id: string) => void; onSession: (id: string) => void; onCreate: (defaults?: Defaults) => void; onAddProject: () => void; onPreset: (preset: Preset) => void; onAll: () => void; onInbox: () => void; onPresets: () => void };
const stateClass = (session: Session) => session.readOnly ? "st-ended" : ({ starting: "st-running", running: "st-running", idle: "st-running", waiting: "st-needs", exited: "st-ended", interrupted: "st-stalled", error: "st-failed" }[session.status]);
const statusLabel = (session: Session, zh: boolean) => session.readOnly ? (zh ? "只读" : "Read-only") : zh ? ({ starting: "启动中", running: "运行中", idle: "空闲", waiting: "需要你", exited: "已结束", interrupted: "停滞", error: "失败" })[session.status] : session.status;

export function WorkbenchPage({ data, recentIds = [], onSession, onCreate, onAddProject, onAll, onInbox, onPresets }: Props) {
  const zh = data.settings.language !== "en";
  const agents = useMemo(() => workbenchAgents(data.providers, zh), [data.providers, zh]);
  const [projectId, setProjectId] = useState(data.projects[0]?.id ?? "");
  const [trees, setTrees] = useState<Worktree[]>([]);
  const [treesLoading, setTreesLoading] = useState(false);
  const [path, setPath] = useState("");
  const [provider, setProvider] = useState<ProviderId>(data.providers.find(item => item.id === "codex" && item.installed)?.id ?? "shell");
  const [title, setTitle] = useState("");
  useEffect(() => {
    let current = true;
    if (!projectId) { setTrees([]); setPath(""); setTreesLoading(false); return () => { current = false; }; }
    setTreesLoading(true); setTrees([]); setPath("");
    void request("worktree.list", { projectId }).then(next => { if (current) { setTrees(next); setPath(next[0]?.path ?? ""); } }).catch(() => { if (current) setTrees([]); }).finally(() => { if (current) setTreesLoading(false); });
    return () => { current = false; };
  }, [projectId]);
  const sessions = useMemo(() => [...data.sessions].filter(session => !session.archived).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [data.sessions]);
  const recent = useMemo(() => { const byId = new Map(sessions.map(session => [session.id, session])); const opened = recentIds.map(id => byId.get(id)).filter((session): session is Session => Boolean(session)); const openedIds = new Set(opened.map(session => session.id)); return [...opened, ...sessions.filter(session => !openedIds.has(session.id))]; }, [recentIds, sessions]);
  const inbox = data.inbox.filter(item => isActionableInboxItem(item));
  const projectName = (id?: string) => data.projects.find(project => project.id === id)?.name ?? (zh ? "未归属" : "Unattributed");
  const create = () => onCreate({ projectId: projectId || undefined, path: path || undefined, provider, title: title.trim() || undefined });
  return <section className="start workbench-page"><h1 className="start-q">{zh ? "从哪开始？" : "Where do you want to start?"}</h1><div className="composer"><textarea value={title} onChange={event => setTitle(event.target.value)} rows={2} maxLength={500} placeholder={zh ? "描述要开的会话，或直接选项目开始…" : "Describe a session to start, or choose a project…"} /><div className="composer-row"><Picker icon="folder" value={projectId} onChange={setProjectId} label={zh ? "选择项目" : "Choose project"} options={data.projects.map(project => [project.id, project.name])} /><Picker icon="branch" value={path} onChange={setPath} label={treesLoading ? (zh ? "加载目录…" : "Loading directories…") : (zh ? "选择目录" : "Choose worktree")} options={trees.map(tree => [tree.path, tree.branch ?? displayPath(tree.path)])} disabled={treesLoading || !trees.length} /><AgentPicker value={provider} onChange={setProvider} agents={agents} label={zh ? "选择 Agent" : "Choose agent"} /><button type="button" className="composer-send" onClick={create} aria-label={zh ? "新建终端" : "New terminal"}><Icon name="chevR" /></button></div></div><Label text={zh ? "继续上次" : "Continue"} /><div className="quiet-block">{recent[0] ? <Row session={recent[0]} project={projectName(recent[0].projectId)} onSession={onSession} zh={zh} continuing /> : <Empty text={zh ? "暂无继续项 · 从上方开始一个新会话" : "Nothing to continue · start above"} />}</div><Label text={zh ? "待处理" : "Inbox"} />{inbox.length ? <button className="inbox-strip" onClick={onInbox}><span className="dot st-needs" /><span className="grow">{zh ? `${inbox.length} 项需要你` : `${inbox.length} need your attention`}</span><span className="link">{zh ? "查看全部" : "View all"} <Icon name="chevR" /></span></button> : <Empty text={zh ? "暂无待处理项 · 一切正常" : "Nothing needs attention · all clear"} />}<Label text={zh ? "最近会话" : "Recent sessions"} /><div className="quiet-block">{[0, 1, 2].map(index => recent[index] ? <Row key={recent[index].id} session={recent[index]} project={projectName(recent[index].projectId)} onSession={onSession} zh={zh} /> : <Empty key={index} text={zh ? "暂无更多会话" : "No more sessions"} />)}</div><div className="workbench-links"><button onClick={onAll}>{zh ? "所有终端" : "All terminals"}</button><button onClick={onPresets}>{zh ? "工作预设" : "Work presets"}</button>{!data.projects.length && <button onClick={onAddProject}>{zh ? "添加项目" : "Add project"}</button>}</div></section>;
}
function Picker({ icon, value, onChange, label, options, disabled = false }: { icon: string; value: string; onChange: (value: string) => void; label: string; options: [string, string][]; disabled?: boolean }) { return <label className={`composer-chip${disabled ? " disabled" : ""}`}><Icon name={icon} /><Select className="composer-select" value={value} onChange={event => onChange(event.target.value)} disabled={disabled} aria-label={label}>{!value && <option value="">{label}</option>}{options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}</Select></label>; }
function AgentPicker({ value, onChange, agents, label }: { value: ProviderId; onChange: (value: ProviderId) => void; agents: WorkbenchAgent[]; label: string }) {
  const [open, setOpen] = useState(false);
  const selected = agents.find(agent => agent.id === value) ?? agents[0];
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : undefined;
      if (!target?.closest(".composer-agent")) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  if (!selected) return null;
  return <div className="composer-agent">
    <button type="button" className="composer-chip composer-agent-chip" data-menu-trigger="agent" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen(current => !current)}>
      <AgentIcon provider={selected.id} size={16} /><span className="composer-agent-name">{selected.name}</span><Icon name="chevD" />
    </button>
    {open && <div className="composer-agent-menu" role="menu" aria-label={label}>
      {agents.map(agent => <button type="button" role="menuitemradio" aria-checked={agent.id === value} className={`composer-agent-item${agent.id === value ? " active" : ""}`} disabled={!agent.available} key={agent.id} onClick={() => { onChange(agent.id); setOpen(false); }}>
        <AgentIcon provider={agent.id} size={16} /><span className="composer-agent-item-name">{agent.name}</span>{agent.hint ? <small>{agent.hint}</small> : null}{agent.id === value ? <Icon name="check" className="composer-agent-check" /> : <span className="composer-agent-check" />}
      </button>)}
    </div>}
  </div>;
}
function Label({ text }: { text: string }) { return <div className="start-label">{text}</div>; }
function Empty({ text }: { text: string }) { return <div className="quiet-row placeholder"><span className="quiet-name grow">{text}</span></div>; }
function Row({ session, project, onSession, zh, continuing = false }: { session: Session; project: string; onSession: (id: string) => void; zh: boolean; continuing?: boolean }) { return <button className="quiet-row" onClick={() => onSession(session.id)}>{continuing ? <span className={`dot ${stateClass(session)}`} /> : <AgentIcon provider={session.provider} />}<span className="quiet-name grow">{session.title}</span><span className="meta">{project} · {sessionTime(session.updatedAt, zh ? "zh-CN" : "en")}</span><span className={`chip ${stateClass(session)}`}>{statusLabel(session, zh)}</span>{continuing && <span className="meta">{zh ? "继续" : "Continue"} <Icon name="chevR" /></span>}</button>; }
