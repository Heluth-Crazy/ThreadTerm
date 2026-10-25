import { createPortal } from "react-dom";
import { localeFromSettings, translate } from "../i18n";
import { Select } from "./ui/Select";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ProviderId, Session, Snapshot, Worktree } from "@threadterm/protocol";
import { request } from "../bridge";
import { sessionTime } from "../sessionTime";
import { AgentIcon, Icon } from "./PrototypeIcon";
import { isActionableInboxItem } from "../inboxVisibility";
import { displayPath } from "../projectScope";
import { workbenchAgents, type WorkbenchAgent } from "./workbenchAgents";
import { firstReadyAgent, providerReadiness } from "../providerReadiness";
import { clampContextMenu, nextMenuIndex } from "../contextMenuActions";
import { ProviderReadinessAction } from "./ProviderReadinessAction";
import "./workbench-page.css";

type Defaults = { projectId?: string; path?: string; provider?: ProviderId; title?: string; draft?: string; mode?: "chat" | "terminal" };
type Props = { data: Snapshot; recentIds?: string[]; onProject: (id: string) => void; onSession: (id: string) => void; onCreate: (defaults?: Defaults) => void; onAddProject: () => void; onAll: () => void; onInbox: () => void; onOpenSettings?: () => void; onCreated?: (session: Session) => void };
const stateClass = (session: Session) => session.readOnly ? "st-ended" : ({ starting: "st-running", running: "st-running", idle: "st-running", waiting: "st-needs", exited: "st-ended", interrupted: "st-stalled", error: "st-failed" }[session.status]);
const statusLabel = (session: Session, zh: boolean) => session.readOnly ? (zh ? "只读" : "Read-only") : translate(zh ? "zh-CN" : "en", session.status);

export function WorkbenchPage({ data, recentIds = [], onSession, onCreate, onAddProject, onAll, onInbox, onOpenSettings, onCreated }: Props) {
  const zh = localeFromSettings(data.settings) === "zh-CN";
  const agents = useMemo(() => workbenchAgents(data.providers, zh, "preferred"), [data.providers, zh]);
  const [projectId, setProjectId] = useState(data.projects[0]?.id ?? "");
  const [trees, setTrees] = useState<Worktree[]>([]);
  const [treesLoading, setTreesLoading] = useState(false);
  const [path, setPath] = useState("");
  const [provider, setProvider] = useState<ProviderId | undefined>(() => firstReadyAgent(data.providers));
  const [title, setTitle] = useState("");
  useEffect(() => { setProvider(current => current ?? firstReadyAgent(data.providers)); }, [data.providers]);
  const selected = agents.find(agent => agent.id === provider);
  const selectedMode = provider === "shell" || provider === "custom" ? "terminal" : providerReadiness(data.providers.find(item => item.id === provider), "preferred", zh).mode;
  const noReadyAgent = !firstReadyAgent(data.providers);
  const remedies = data.providers.map(capability => ({ capability, readiness: providerReadiness(capability, "preferred", zh) })).filter((item, index, all) => (item.readiness.action === "install" || item.readiness.action === "signIn") && all.findIndex(other => other.readiness.action === item.readiness.action) === index);
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
  const create = () => { if (!selected?.available) return; onCreate({ projectId: projectId || undefined, path: path || undefined, provider, mode: selectedMode, title: title.trim().replace(/\s+/g, " ").slice(0, 60) || undefined, ...(selectedMode === "chat" ? { draft: title } : {}) }); };
  return <section className="start workbench-page"><h1 className="start-q">{zh ? "从哪开始？" : "Where do you want to start?"}</h1><div className="composer"><textarea value={title} onChange={event => setTitle(event.target.value)} rows={2} maxLength={500} aria-label={selectedMode === "chat" && provider ? (zh ? "聊天草稿" : "Chat draft") : (zh ? "会话标题" : "Session title")} placeholder={selectedMode === "chat" && provider ? (zh ? "聊天草稿（可选）— 打开后由你点击发送…" : "Chat draft (optional) — press Send after opening…") : (zh ? "会话标题（可选）" : "Session title (optional)")} /><div className="composer-row"><Picker icon="folder" value={projectId} onChange={setProjectId} label={zh ? "选择项目" : "Choose project"} options={data.projects.map(project => [project.id, project.name])} /><Picker icon="branch" value={path} onChange={setPath} label={treesLoading ? (zh ? "加载目录…" : "Loading directories…") : (zh ? "选择目录" : "Choose worktree")} options={trees.map(tree => [tree.path, tree.branch ?? displayPath(tree.path)])} disabled={treesLoading || !trees.length} /><AgentPicker value={provider} onChange={setProvider} agents={agents} data={data} projectId={projectId} zh={zh} onCreated={session => onCreated ? onCreated(session) : onSession(session.id)} onOpenSettings={onOpenSettings} label={zh ? "选择 Agent" : "Choose agent"} /><button type="button" className="composer-send" disabled={!selected?.available} onClick={create} aria-label={selectedMode === "chat" ? (zh ? "新建聊天" : "New chat") : (zh ? "新建终端" : "New terminal")}><Icon name="chevR" /></button></div></div>{noReadyAgent && <div className="group-notice" role="status" data-testid="first-run-readiness"><Icon name="info" /><span>{zh ? "没有可用的智能体。请安装或登录智能体。" : "No agent is ready. Install or sign in to an agent."}</span>{remedies.map(({ capability, readiness }) => <ProviderReadinessAction key={capability.id} readiness={readiness} capability={capability} data={data} projectId={projectId} zh={zh} onCreated={session => onCreated ? onCreated(session) : onSession(session.id)} onOpenSettings={onOpenSettings} />)}<button type="button" className="btn btn-sm" onClick={onOpenSettings}>{zh ? "打开提供商设置" : "Open provider settings"}</button></div>}<Label text={zh ? "继续上次" : "Continue"} /><div className="quiet-block">{recent[0] ? <Row session={recent[0]} project={projectName(recent[0].projectId)} onSession={onSession} zh={zh} continuing /> : <Empty text={zh ? "暂无继续项 · 从上方开始一个新会话" : "Nothing to continue · start above"} />}</div><Label text={zh ? "待处理" : "Inbox"} />{inbox.length ? <button className="inbox-strip" onClick={onInbox}><span className="dot st-needs" /><span className="grow">{zh ? `${inbox.length} 项需要你` : `${inbox.length} need your attention`}</span><span className="link">{zh ? "查看全部" : "View all"} <Icon name="chevR" /></span></button> : <Empty text={zh ? "暂无待处理项 · 一切正常" : "Nothing needs attention · all clear"} />}<Label text={zh ? "最近会话" : "Recent sessions"} /><div className="quiet-block">{[0, 1, 2].map(index => recent[index] ? <Row key={recent[index].id} session={recent[index]} project={projectName(recent[index].projectId)} onSession={onSession} zh={zh} /> : <Empty key={index} text={zh ? "暂无更多会话" : "No more sessions"} />)}</div><div className="workbench-links"><button onClick={onAll}>{zh ? "所有终端" : "All terminals"}</button>{!data.projects.length && <button onClick={onAddProject}>{zh ? "添加项目" : "Add project"}</button>}</div></section>;
}
function Picker({ icon, value, onChange, label, options, disabled = false }: { icon: string; value: string; onChange: (value: string) => void; label: string; options: [string, string][]; disabled?: boolean }) { return <label className={`composer-chip${disabled ? " disabled" : ""}`}><Icon name={icon} /><Select className="composer-select" value={value} onChange={event => onChange(event.target.value)} disabled={disabled} aria-label={label}>{!value && <option value="">{label}</option>}{options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}</Select></label>; }
function AgentPicker({ value, onChange, agents, label, data, projectId, zh, onCreated, onOpenSettings }: { value?: ProviderId; onChange: (value: ProviderId) => void; agents: WorkbenchAgent[]; label: string; data: Snapshot; projectId?: string; zh: boolean; onCreated: (session: Session) => void; onOpenSettings?: () => void }) {
  const [open, setOpen] = useState(false);
  const selected = agents.find(agent => agent.id === value);
  const host = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !host.current) return;
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect(), anchor = host.current.getBoundingClientRect();
    const position = clampContextMenu(anchor.left, anchor.bottom + 6, rect.width, rect.height, window.innerWidth, window.innerHeight);
    menu.style.left = `${position.left}px`;
    menu.style.top = `${position.top}px`;
    menu.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : undefined;
      if (!target?.closest(".composer-agent") && !target?.closest(".composer-agent-menu") && !target?.closest(".runtime-overlay")) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  return <div className="composer-agent" ref={host} onKeyDown={event => {
    if (!open || !(event.target instanceof Node) || !host.current?.contains(event.target) && !menuRef.current?.contains(event.target)) return;
    if (event.key === "Tab") { setOpen(false); trigger.current?.focus(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = nextMenuIndex(event.key, index, items.length);
    items[next]?.focus();
  }}>
    <button type="button" ref={trigger} className="composer-chip composer-agent-chip" data-menu-trigger="agent" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen(current => !current)}>
      <AgentIcon provider={selected?.id ?? "custom"} size={16} /><span className="composer-agent-name">{selected?.name ?? label}</span><Icon name="chevD" />
    </button>
    {open && createPortal(<div className="workbench-page"><div ref={menuRef} className="composer-agent-menu" role="menu" aria-label={label}>
      {agents.map(agent => <div key={agent.id} role="none" className="composer-agent-option"><button type="button" role="menuitemradio" aria-checked={agent.id === value} className={`composer-agent-item${agent.id === value ? " active" : ""}`} disabled={!agent.available} title={agent.hint} onClick={() => { onChange(agent.id); trigger.current?.focus(); setOpen(false); }}>
        <AgentIcon provider={agent.id} size={16} /><span className="composer-agent-item-name">{agent.name}</span>{agent.hint ? <small>{agent.hint}</small> : null}{agent.id === value ? <Icon name="check" className="composer-agent-check" /> : <span className="composer-agent-check" />}
      </button>{!agent.available && <ProviderReadinessAction readiness={providerReadiness(data.providers.find(item => item.id === agent.id), "preferred", zh)} capability={data.providers.find(item => item.id === agent.id)} data={data} projectId={projectId} zh={zh} onCreated={onCreated} onOpenSettings={onOpenSettings} menu />}</div>)}
    </div></div>, document.body)}
  </div>;
}
function Label({ text }: { text: string }) { return <div className="start-label">{text}</div>; }
function Empty({ text }: { text: string }) { return <div className="quiet-row placeholder"><span className="quiet-name grow">{text}</span></div>; }
function Row({ session, project, onSession, zh, continuing = false }: { session: Session; project: string; onSession: (id: string) => void; zh: boolean; continuing?: boolean }) { return <button className="quiet-row" onClick={() => onSession(session.id)}>{continuing ? <span className={`dot ${stateClass(session)}`} /> : <AgentIcon provider={session.provider} />}<span className="quiet-name grow">{session.title}</span><span className="meta">{project} · {sessionTime(session.updatedAt, zh ? "zh-CN" : "en")}</span><span className={`chip ${stateClass(session)}`}>{statusLabel(session, zh)}</span>{continuing && <span className="meta">{zh ? "继续" : "Continue"} <Icon name="chevR" /></span>}</button>; }
