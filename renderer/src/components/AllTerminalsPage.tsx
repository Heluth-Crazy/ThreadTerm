import { Select } from "./ui/Select";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Session, SessionStatus, Snapshot, Worktree } from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import { useTranslation } from "../i18n";
import { displayPath, sameCanonicalScope } from "../projectScope";
import { hasDirtyEditorsInScope } from "../dirtyEditors";
import { AgentIcon, Icon } from "./PrototypeIcon";
import { HistoryRail } from "./HistoryRail";
import "./all-terminals.css";
import { sessionState, sessionStateLabel } from "../sessionState";

export type SessionScope = "all" | "active" | "recent" | "followed" | "bookmarked" | "archived";
type Layout = "cards" | "list";
type Output = { text?: string; complete: boolean; issue?: string };
type Props = {
  data: Snapshot; recentIds: string[]; initialScope?: SessionScope; highlightedSessionId?: string;
  onSession: (id: string) => void; onChanged: () => void; historyOpen: boolean;
  onCloseHistory: () => void; onOpenHistory: () => void; onLocalHistory: () => void;
};

const active = (session: Session) => !session.readOnly && ["starting", "running", "idle", "waiting"].includes(session.status);
const statusClass = (session: Session) => session.readOnly ? "st-ended" : ({ starting: "st-running", running: "st-running", idle: "st-running", waiting: "st-needs", exited: "st-ended", interrupted: "st-stalled", error: "st-failed" }[session.status]);
const activityRank = (session: Session) => session.readOnly ? 4 : ({ waiting: 0, error: 1, starting: 2, running: 2, idle: 2, interrupted: 3, exited: 4 }[session.status]);
const displayProvider = (provider: string) => provider === "claude" ? "Claude Code" : provider === "codex" ? "Codex" : provider[0].toUpperCase() + provider.slice(1);
const decode = (value: string) => new TextDecoder().decode(Uint8Array.from(atob(value), char => char.charCodeAt(0)));
const latestText = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) ?? "";
const chatText = (snapshot: Awaited<ReturnType<typeof request<"chat.snapshot">>>) => snapshot.items.flatMap(item => item.parts.map(part => typeof part.text === "string" ? part.text : typeof part.data === "string" ? part.data : "")).filter(Boolean).slice(-8).join("\n");

async function boundedTerminalTail(sessionId: string): Promise<Output> {
  // `tail` is the explicit bounded latest-output protocol. Cursor omission has
  // different semantics (offset zero), so never use it to claim a recent line.
  const result = await request("terminal.read", { sessionId, tail: true, limit: 8192 });
  return { text: decode(result.data), complete: true };
}

async function boundedMap<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>) {
  const result: R[] = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (index < values.length) { const current = index++; result[current] = await fn(values[current]); }
  }));
  return result;
}

export function AllTerminalsPage({ data, recentIds, initialScope = "all", highlightedSessionId, onSession, onChanged, historyOpen, onCloseHistory, onOpenHistory, onLocalHistory }: Props) {
  const { locale, formatDate } = useTranslation();
  const zh = locale === "zh-CN";
  const copy = (en: string, cn: string) => zh ? cn : en;
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("all");
  const [worktreePath, setWorktreePath] = useState("all");
  const [status, setStatus] = useState<SessionStatus | "all">("all");
  const [scope, setScope] = useState<SessionScope>(initialScope);
  const [layout, setLayout] = useState<Layout>("cards");
  const [inspectId, setInspectId] = useState<string | undefined>(highlightedSessionId);
  const [outputs, setOutputs] = useState<Record<string, Output>>({});
  const [worktrees, setWorktrees] = useState<Record<string, Worktree[]>>({});
  const [menuFor, setMenuFor] = useState<string>();
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [orderMode, setOrderMode] = useState(false);
  const [draggedId, setDraggedId] = useState<string>();
  const [issue, setIssue] = useState<string>();
  const generation = useRef(0);

  useEffect(() => { setScope(initialScope); }, [initialScope]);
  useEffect(() => { if (highlightedSessionId) setInspectId(highlightedSessionId); }, [highlightedSessionId]);
  useEffect(() => { if (projectId !== "all" && !data.projects.some(project => project.id === projectId)) setProjectId("all"); }, [data.projects, projectId]);
  useEffect(() => { setWorktreePath("all"); }, [projectId]);
  useEffect(() => {
    let alive = true;
    void boundedMap(data.projects, 4, project => request("worktree.list", { projectId: project.id }).then(items => [project.id, items] as const).catch(() => [project.id, []] as const)).then(rows => {
      if (alive) setWorktrees(Object.fromEntries(rows));
    });
    return () => { alive = false; };
  }, [data.projects]);
  useEffect(() => {
    const current = ++generation.current;
    const sessions = data.sessions.slice(0, 80);
    void boundedMap(sessions, 4, async session => {
      try {
        const result = session.mode === "chat" || session.readOnly
          ? { text: chatText(await request("chat.snapshot", { sessionId: session.id })), complete: true }
          : await boundedTerminalTail(session.id);
        return [session.id, result] as const;
      } catch (error) { return [session.id, { complete: false, issue: error instanceof Error ? error.message : copy("Output unavailable.", "输出不可用。") }] as const; }
    }).then(rows => { if (current === generation.current) setOutputs(previous => ({ ...previous, ...Object.fromEntries(rows) })); });
  }, [data.sessions, locale]);

  const visibleWorktrees = useMemo(() => Object.values(worktrees).flat().filter(tree => projectId === "all" || tree.projectId === projectId), [worktrees, projectId]);
  const projectName = (id?: string) => data.projects.find(project => project.id === id)?.name ?? copy("Unattributed", "未归属");
  const branchFor = (session: Session) => visibleWorktrees.find(tree => tree.path === session.worktreePath)?.branch ?? (session.worktreePath ? copy("working directory", "工作目录") : copy("No working directory", "未提供工作目录"));
  const unavailable = (session: Session) => Boolean(session.worktreePath && worktrees[session.projectId ?? ""] && !worktrees[session.projectId ?? ""].some(tree => tree.path === session.worktreePath && !tree.missing));
  const matches = (session: Session) => {
    const output = outputs[session.id]?.text ?? "";
    const text = `${session.title} ${displayProvider(session.provider)} ${projectName(session.projectId)} ${branchFor(session)} ${session.worktreePath ?? ""} ${displayPath(session.worktreePath)} ${output}`.toLowerCase();
    return (!query || text.includes(query.toLowerCase())) && (projectId === "all" || session.projectId === projectId) && (worktreePath === "all" || session.worktreePath === worktreePath) && (status === "all" || session.status === status) &&
      (scope === "all" || scope === "active" && active(session) || scope === "recent" && recentIds.includes(session.id) || scope === "followed" && session.followed || scope === "bookmarked" && session.bookmarked || scope === "archived" && session.archived);
  };
  const visible = data.sessions.filter(matches).sort((a, b) => {
    if (orderMode) return (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER);
    const recentIndex = (id: string) => { const index = recentIds.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
    return activityRank(a) - activityRank(b) || recentIndex(a.id) - recentIndex(b.id);
  });
  const inspected = data.sessions.find(item => item.id === inspectId);
  const locked = Boolean(query || worktreePath !== "all" || status !== "all" || projectId !== "all");
  const selectCard = (id: string) => { setInspectId(id); setMenuFor(undefined); if (historyOpen) onCloseHistory(); };
  const toggleSelected = (id: string) => setSelected(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const patchOrganization = async (session: Session, patch: { pinned?: boolean; bookmarked?: boolean; archived?: boolean }) => {
    setIssue(undefined);
    try {
      if (patch.archived === true && session.projectId && hasDirtyEditorsInScope({projectId:session.projectId,sessionId:session.id})) throw new Error(copy("Save or close this session's edited files before archiving.", "请先保存或关闭此会话中的文件修改，再进行归档。"));
      if (patch.archived === false) {
        const visibility = await request("catalog.visibility.list", {});
        const parent = visibility.find(entry => entry.visibility === 'archived' && (entry.kind === 'project' ? entry.id === session.projectId : entry.kind === 'worktree' && entry.projectId === session.projectId && sameCanonicalScope(entry.worktreePath, session.worktreePath ?? data.projects.find(project=>project.id===session.projectId)?.path)));
        if (parent) throw new Error(copy("Restore the archived project or worktree from its parent sidebar menu first.", "请先从侧栏的上级菜单恢复已归档的项目或工作树。"));
      }
      await request("session.organize", { sessionId: session.id, ...patch, expectedRevision: session.organizationRevision ?? 0, operationId: operationId() }); onChanged();
    }
    catch (error) { setIssue(error instanceof Error ? error.message : copy("Session update failed.", "会话更新失败。")); }
    finally { setMenuFor(undefined); }
  };
  const updateFollow = async (followed: boolean) => {
    const targets = data.sessions.filter(session => selected.has(session.id) && session.followed !== followed);
    if (!targets.length) return;
    const results = await Promise.allSettled(targets.map(session => request("session.update", { sessionId: session.id, followed, operationId: operationId() })));
    if (results.some(result => result.status === "fulfilled")) { setSelected(new Set()); onChanged(); }
    const failed = results.find(result => result.status === "rejected"); if (failed?.status === "rejected") setIssue(failed.reason instanceof Error ? failed.reason.message : copy("Some sessions could not be updated.", "部分会话无法更新。"));
  };
  const reorder = async (sourceId: string, targetId: string) => {
    if (locked) return;
    const source = visible.findIndex(item => item.id === sourceId), target = visible.findIndex(item => item.id === targetId);
    if (source < 0 || target < 0 || source === target) return;
    const reordered = [...visible]; const [moved] = reordered.splice(source, 1); reordered.splice(target, 0, moved);
    const results = await Promise.allSettled(reordered.map((item, sortOrder) => request("session.organize", { sessionId: item.id, sortOrder, expectedRevision: item.organizationRevision ?? 0, operationId: operationId() })));
    onChanged(); if (results.some(result => result.status === "rejected")) setIssue(copy("Ordering was reconciled after a revision conflict.", "排序已在修订冲突后重新同步。"));
  };

  const running = visible.filter(session => sessionState(session) === "running").length, needs = visible.filter(session => sessionState(session) === "needs").length;
  const summary = [zh ? `${visible.length} 个终端` : `${visible.length} ${visible.length === 1 ? "terminal" : "terminals"}`, ...(running ? [zh ? `${running} 个运行中` : `${running} running`] : []), ...(needs ? [zh ? `${needs} 个需要你` : `${needs} need${needs === 1 ? "s" : ""} you`] : [])].join(" · ");
  // The side rail exists only for something to show: a selected card's summary or native history the user opened.
  const railOpen = Boolean(inspected) || historyOpen;
  return <section className="page terminals-page">
    <div className="page-head"><div><h1 className="page-title">{copy("All terminals", "所有终端")}</h1><p className="page-sub">{summary}</p></div><div className="page-actions terminals-page-actions"><button className="btn" onClick={() => { setInspectId(undefined); onLocalHistory(); }}><Icon name="archive" />{copy("Local history", "本机历史")}</button><button className="icon-btn" aria-label={copy("Terminal page options", "终端页选项")} aria-expanded={pageMenuOpen} onClick={() => setPageMenuOpen(value => !value)}><Icon name="more" /></button>{pageMenuOpen && <div className="popover terminals-page-menu"><label><span className="menu-label">{copy("Saved records", "已保存记录")}</span><Select value={scope} onChange={event => { setScope(event.target.value as SessionScope); setSelected(new Set()); }}><option value="all">{copy("All sessions", "全部会话")}</option><option value="active">{copy("Active", "活跃")}</option><option value="recent">{copy("Recent", "最近")}</option><option value="followed">{copy("Followed", "已关注")}</option><option value="bookmarked">{copy("Bookmarks", "书签")}</option><option value="archived">{copy("Archived", "已归档")}</option></Select></label><button className="menu-item" aria-pressed={orderMode} disabled={locked} title={locked ? copy("Clear filters before changing saved order.", "清除筛选后才能调整保存的顺序。") : undefined} onClick={() => { setOrderMode(value => !value); setPageMenuOpen(false); }}>{orderMode ? copy("Stop manual ordering", "结束手动排序") : copy("Manual order", "手动排序")}</button><button className="menu-item" aria-pressed={historyOpen && !inspected} onClick={() => { setPageMenuOpen(false); if (historyOpen && !inspected) onCloseHistory(); else { setInspectId(undefined); onOpenHistory(); } }}>{historyOpen && !inspected ? copy("Hide native session history", "隐藏本机会话历史") : copy("Native session history", "本机会话历史")}</button></div>}</div></div>
    <div className="t-filters">
      <div className="t-search"><span className="filter-label">{copy("Search", "搜索")}</span><div className="input-wrap"><Icon name="search" /><input aria-label={copy("Search all terminals", "搜索所有终端")} value={query} onChange={event => setQuery(event.target.value)} placeholder={copy("Search sessions, projects, or recent output", "搜索会话、项目或最近输出")} /></div></div>
      <label><span className="filter-label">{copy("Project", "项目")}</span><Select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="all">{copy("All projects", "全部项目")}</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</Select></label>
      <label><span className="filter-label">{copy("Directory", "目录")}</span><Select value={worktreePath} onChange={event => setWorktreePath(event.target.value)}><option value="all">{copy("All working directories", "全部工作目录")}</option>{visibleWorktrees.map(tree => <option key={tree.id} value={tree.path}>{projectId === "all" ? `${projectName(tree.projectId)} · ${tree.branch ?? displayPath(tree.path)}` : tree.branch ?? displayPath(tree.path)}</option>)}</Select></label>
      <label><span className="filter-label">{copy("Status", "状态")}</span><Select value={status} onChange={event => setStatus(event.target.value as SessionStatus | "all")}><option value="all">{copy("All statuses", "全部状态")}</option>{(["starting", "running", "idle", "waiting", "exited", "interrupted", "error"] as SessionStatus[]).map(value => <option key={value} value={value}>{copy(({ starting: "Starting", running: "Running", idle: "Idle", waiting: "Needs you", exited: "Ended", interrupted: "Stalled", error: "Failed" })[value], ({ starting: "启动中", running: "运行中", idle: "空闲", waiting: "需要你", exited: "已结束", interrupted: "停滞", error: "失败" })[value])}</option>)}</Select></label>
      <div><span className="filter-label">{copy("Display", "显示方式")}</span><div className="seg" role="group" aria-label={copy("Display mode", "显示方式")}><button className={`seg-btn${layout === "cards" ? " active" : ""}`} aria-pressed={layout === "cards"} onClick={() => setLayout("cards")}>{copy("Cards", "卡片")}</button><button className={`seg-btn${layout === "list" ? " active" : ""}`} aria-pressed={layout === "list"} onClick={() => setLayout("list")}>{copy("List", "列表")}</button></div></div>
    </div>
    {selected.size > 0 && <div className="terminals-bulk" role="group" aria-label={copy("Selected terminal actions", "所选终端操作")}><span>{selected.size} {copy("selected", "项已选")}</span><button onClick={() => void updateFollow(true)}>{copy("Follow selected", "关注所选")}</button><button onClick={() => void updateFollow(false)}>{copy("Unfollow selected", "取消关注所选")}</button><button onClick={() => setSelected(new Set())}>{copy("Clear", "清除")}</button></div>}
    {issue && <p className="surface-error" role="alert">{issue}</p>}
    <div className={`t-split${railOpen ? " has-rail" : ""}`}><div className="t-main">{visible.length ? <div className={`t-grid${layout === "list" ? " list" : ""}`}>{visible.map((session, index) => {
      const output = outputs[session.id]; const display = output?.text ? latestText(output.text) : output?.issue ?? copy("Reading recent output…", "正在读取最近输出…"); const stateLabel = sessionStateLabel(sessionState(session), zh, session.readOnly);
      const missing = unavailable(session);
      return <article key={session.id} className={`panel t-card${missing ? " unavailable" : ""}${session.id === inspectId ? " highlight" : ""}${session.id === highlightedSessionId ? " history-target" : ""}`} draggable={orderMode && !locked} onDragStart={() => setDraggedId(session.id)} onDragOver={event => { if (orderMode && !locked && draggedId) event.preventDefault(); }} onDrop={() => { if (draggedId) void reorder(draggedId, session.id); setDraggedId(undefined); }} onDragEnd={() => setDraggedId(undefined)} onClick={() => selectCard(session.id)}>
        <div className="tc-head"><div className="tc-main minw0"><div className="tc-name"><AgentIcon provider={session.provider} />{session.pinned && <Icon name="bookmark" />}{session.title}</div><div className="tc-sub">{projectName(session.projectId)} · {branchFor(session)}</div></div><span className={`chip ${statusClass(session)}`}>{stateLabel}</span></div>
        <p className="tc-out" title={display}>{output && !output.complete ? `${display || copy("Output preview", "输出预览")} · ${copy("preview limit", "预览已达上限")}` : display}</p>
        <details className="tc-details" onClick={event => event.stopPropagation()}><summary>{copy("Directory and session info", "目录与会话信息")}</summary><div className="body"><code>{displayPath(session.worktreePath) || "—"}</code><span>{displayProvider(session.provider)} · {session.mode === "chat" ? copy("Structured Chat", "结构化聊天") : copy("Terminal", "终端")}</span><span>{sessionStateLabel(sessionState(session), zh, session.readOnly)} · {formatDate(session.updatedAt)}</span></div></details>{missing && <small className="card-reason">{copy("Working directory is unavailable; history remains readable and can continue after relocation.", "目录不可用；历史仍可阅读，重新定位后才可继续。")}</small>}
        <div className="tc-actions">{orderMode && <><button className="icon-btn" disabled={locked || index === 0} aria-label={copy("Move earlier", "前移")} onClick={event => { event.stopPropagation(); void reorder(session.id, visible[index - 1].id); }}>↑</button><button className="icon-btn" disabled={locked || index === visible.length - 1} aria-label={copy("Move later", "后移")} onClick={event => { event.stopPropagation(); void reorder(session.id, visible[index + 1].id); }}>↓</button></>}<button className="btn" onClick={event => { event.stopPropagation(); if (missing) onLocalHistory(); else onSession(session.id); }}>{missing ? copy("View history", "查看历史") : copy("Open terminal", "打开终端")}</button><button className="icon-btn" aria-label={copy("More actions", "更多操作")} aria-expanded={menuFor === session.id} onClick={event => { event.stopPropagation(); setMenuFor(menuFor === session.id ? undefined : session.id); }}><Icon name="more" /></button>{menuFor === session.id && <div className="popover terminals-card-menu" onClick={event => event.stopPropagation()}><button className="menu-item" onClick={() => toggleSelected(session.id)}>{selected.has(session.id) ? copy("Unselect", "取消选择") : copy("Select for bulk actions", "选择以批量操作")}</button><button className="menu-item" onClick={() => void patchOrganization(session, { pinned: !session.pinned })}>{session.pinned ? copy("Unpin", "取消固定") : copy("Pin", "固定")}</button><button className="menu-item" onClick={() => void patchOrganization(session, { bookmarked: !session.bookmarked })}>{session.bookmarked ? copy("Remove bookmark", "移除书签") : copy("Bookmark", "书签")}</button><button className="menu-item" disabled={active(session)} title={active(session) ? copy("End the session before archiving.", "结束会话后可归档。") : undefined} onClick={() => void patchOrganization(session, { archived: !session.archived })}>{session.archived ? copy("Unarchive", "取消归档") : copy("Archive", "归档")}</button><button className="menu-item" onClick={() => void request("session.update", { sessionId: session.id, followed: !session.followed, operationId: operationId() }).then(onChanged).finally(() => setMenuFor(undefined))}>{session.followed ? copy("Unfollow", "取消关注") : copy("Follow", "关注")}</button></div>}</div>
      </article>;
    })}</div> : <div className="panel empty all-empty"><b>{copy("No matching terminals", "没有匹配终端")}</b><p>{copy("Clear filters or choose another project and directory.", "试着清除筛选，或换一个项目和目录。")}</p><button className="btn" onClick={() => { setQuery(""); setProjectId("all"); setWorktreePath("all"); setStatus("all"); setScope("all"); }}>{copy("Clear filters", "清除筛选")}</button></div>}</div>
      {railOpen && <aside className="t-rail" data-testid="terminals-rail">{inspected ? <><header className="t-rail-head"><div><h2>{copy("Session summary", "会话摘要")}</h2><p>{copy("Selecting does not open or resume a process.", "不会打开或恢复进程。")}</p></div><div className="t-rail-head-actions"><button className="btn" onClick={() => { setInspectId(undefined); onOpenHistory(); }}>{copy("Native history", "本机会话历史")}</button><button className="icon-btn" aria-label={copy("Close summary", "关闭摘要")} title={copy("Close summary", "关闭摘要")} onClick={() => setInspectId(undefined)}><Icon name="close" /></button></div></header><div className="t-inspect"><div className="t-inspect-title"><AgentIcon provider={inspected.provider} /><strong>{inspected.title}</strong><span className={`chip ${statusClass(inspected)}`}>{sessionStateLabel(sessionState(inspected), zh, inspected.readOnly)}</span></div><p className="t-inspect-sub">{projectName(inspected.projectId)} · {branchFor(inspected)} · {formatDate(inspected.updatedAt)}</p><code className="t-inspect-path">{displayPath(inspected.worktreePath) || "—"}</code><pre className="t-inspect-out">{outputs[inspected.id]?.text ?? outputs[inspected.id]?.issue ?? copy("Reading recent output…", "正在读取最近输出…")}</pre><div className="t-inspect-actions"><button className="btn btn-primary" onClick={() => onSession(inspected.id)}>{copy("Open terminal", "打开终端")}</button><button className="btn" onClick={() => void request("session.update", { sessionId: inspected.id, followed: !inspected.followed, operationId: operationId() }).then(onChanged)}>{inspected.followed ? copy("Following", "已关注") : copy("Follow", "关注")}</button></div></div></> : <HistoryRail onClose={onCloseHistory} />}</aside>}</div>
  </section>;
}
