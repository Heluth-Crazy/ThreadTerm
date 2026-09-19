import { Select } from "./ui/Select";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatItem, NativeHistoryItem, ProviderCapability, ProviderId, Session, Snapshot } from "@threadterm/protocol";
import { chooseDirectory, operationId, request } from "../bridge";
import { useTranslation } from "../i18n";
import { displayPath } from "../projectScope";
import { SurfaceDialog } from "./SurfaceDialog";
import "./history-rail.css";

const PROVIDERS: ProviderId[] = ["codex", "claude", "kimi", "gemini", "opencode"];
const PAGE_SIZE = 10;
const active = (status: Session["status"]) => ["starting", "running", "idle", "waiting"].includes(status);
const providerName = (provider: ProviderId) => provider === "claude" ? "Claude Code" : provider[0].toUpperCase() + provider.slice(1);
const detailText = (value: unknown) => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2);
type ProviderFilter = ProviderId | "all";
type StatusFilter = "all" | "resumable" | "readOnly" | "owned";
type Props = { onClose?: () => void };

export function HistoryRail({ onClose }: Props) {
  const { locale, formatDate } = useTranslation();
  const copy = (en: string, cn: string) => locale === "zh-CN" ? cn : en;
  const [provider, setProvider] = useState<ProviderFilter>("all");
  const [items, setItems] = useState<NativeHistoryItem[]>([]);
  const [capabilities, setCapabilities] = useState<ProviderCapability[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<NativeHistoryItem>();
  const [transcript, setTranscript] = useState<ChatItem[]>();
  const [mode, setMode] = useState<"terminal" | "chat">("terminal");
  const [cwd, setCwd] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [startedAt, setStartedAt] = useState<number>();
  const [elapsed, setElapsed] = useState(0);
  const [issue, setIssue] = useState<string>();
  const [createdSessionId, setCreatedSessionId] = useState<string>();
  const [createdSession, setCreatedSession] = useState<Session>();
  const [resumeCandidate, setResumeCandidate] = useState<Session>();
  const [scanLimit, setScanLimit] = useState(80);
  const generation = useRef(0);
  const cancel = () => { generation.current += 1; setLoading(false); setStartedAt(undefined); };
  const ownerFor = (item: NativeHistoryItem) => snapshot?.sessions.find(session => session.provider === item.provider && session.nativeId === item.nativeId);
  const scan = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setStartedAt(Date.now()); setIssue(undefined);
    try {
      const next = await request("runtime.snapshot", {});
      const supported = next.providers.filter(capability => capability.history).map(capability => capability.id).filter((id): id is ProviderId => PROVIDERS.includes(id));
      const selectedProviders = provider === "all" ? supported : supported.filter(id => id === provider);
      const results = await Promise.allSettled(selectedProviders.map(id => request("history.list", { provider: id, limit: scanLimit })));
      if (current !== generation.current) return;
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      setSnapshot(next); setCapabilities(next.providers);
      setItems(results.flatMap(result => result.status === "fulfilled" ? result.value.items : []).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
      if (failures.length) setIssue(failures[0].reason instanceof Error ? failures[0].reason.message : copy("Some native histories could not be scanned.", "部分本机历史无法扫描。"));
    } catch (error) { if (current === generation.current) setIssue(error instanceof Error ? error.message : copy("Native history is unavailable.", "本机历史不可用。")); }
    finally { if (current === generation.current) { setLoading(false); setStartedAt(undefined); } }
  }, [provider, locale, scanLimit]);
  useEffect(() => { setPage(1); setSelected(undefined); setTranscript(undefined); setCwd(undefined); setCreatedSessionId(undefined); setCreatedSession(undefined); void scan(); return cancel; }, [scan]);
  useEffect(() => { if (!loading || !startedAt) return; const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250); return () => clearInterval(timer); }, [loading, startedAt]);
  const read = async (item: NativeHistoryItem) => {
    const current = ++generation.current;
    setSelected(item); setTranscript(undefined); setIssue(undefined); setCwd(item.cwd); setMode("terminal"); setCreatedSessionId(undefined); setCreatedSession(undefined); setLoading(true); setStartedAt(Date.now());
    try { const detail = await request("history.read", { provider: item.provider, nativeId: item.nativeId }); if (current === generation.current) setTranscript(detail); }
    catch (error) { if (current === generation.current) setIssue(error instanceof Error ? error.message : copy("The transcript could not be read.", "无法读取记录。")); }
    finally { if (current === generation.current) { setLoading(false); setStartedAt(undefined); } }
  };
  const chooseCwd = async () => { const value = await chooseDirectory(); if (value) setCwd(value); };
  const present = async (session: Session) => request("session.present", { sessionId: session.id, placement: "workspace", presentation: "focused", workspacePath: session.worktreePath, operationId: operationId() });
  const resume = async (session: Session) => {
    setLoading(true); setIssue(undefined);
    try { let path = cwd ?? session.worktreePath ?? selected?.cwd; if (!path) { path = await chooseDirectory() ?? undefined; if (!path) return; } await present(await request("session.resume", { sessionId: session.id, cwd: path, operationId: operationId() })); }
    catch (error) { setIssue(error instanceof Error ? error.message : copy("The session could not be resumed. Choose a valid directory to relocate it.", "无法恢复会话，请选择有效目录重新定位。")); }
    finally { setLoading(false); setResumeCandidate(undefined); }
  };
  const importCard = async () => {
    if (!selected) return;
    setLoading(true); setIssue(undefined); setCreatedSessionId(undefined); setCreatedSession(undefined);
    try { let path = cwd ?? selected.cwd; if (!path) { path = await chooseDirectory() ?? undefined; if (!path) return; } const saved = await request("history.import", { cwd: path, provider: selected.provider, mode, nativeId: selected.nativeId, title: selected.title, operationId: operationId() }); setCreatedSessionId(saved.id); setCreatedSession(saved); setSnapshot(await request("runtime.snapshot", {})); }
    catch (error) { setIssue(error instanceof Error ? error.message : copy("The history card could not be imported. Choose a valid directory to relocate it.", "无法导入历史卡片，请选择有效目录重新定位。")); }
    finally { setLoading(false); }
  };
  const filtered = items.filter(item => { const owner = ownerFor(item); const haystack = `${item.title} ${item.cwd ?? ""} ${item.provider}`.toLowerCase(); return haystack.includes(query.toLowerCase()) && (status === "all" || status === "owned" && Boolean(owner) || status === "resumable" && item.resumable && !owner || status === "readOnly" && !item.resumable); });
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const selectedOwner = selected && ownerFor(selected);
  const selectedCapability = capabilities.find(item => item.id === selected?.provider);
  const itemState = (item: NativeHistoryItem) => ownerFor(item) ? copy("Owned", "已绑定") : item.resumable ? copy("Ready", "可恢复") : copy("Read-only", "只读");
  return <aside className="history-rail history-rail-native" aria-label={copy("Native history", "本机历史")}>
    <header className="history-rail-heading"><div><h3>{copy("Native session history", "本机会话历史")}</h3><p>{loading ? copy(`Scanning native history · ${elapsed}s`, `正在扫描本机历史 · ${elapsed} 秒`) : copy("Reading history never starts a session. Resume requires explicit confirmation.", "读取历史不会启动会话；恢复需要显式确认。")}</p></div>{onClose && <button className="history-close" onClick={onClose} aria-label={copy("Close history", "关闭历史")}>×</button>}</header><div className="history-scan"><button className="primary" disabled={loading} onClick={() => void scan()}>{loading ? copy(`Scanning native history · ${elapsed}s`, `正在扫描本机历史 · ${elapsed} 秒`) : copy("Scan native history", "扫描本机历史")}</button>{loading && <button onClick={cancel}>{copy("Cancel", "取消")}</button>}</div>
    <div className="history-tools"><input aria-label={copy("Search history", "搜索历史")} value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder={copy("Search title or directory", "搜索名称或目录")} /><Select aria-label={copy("History provider", "历史提供方")} value={provider} onChange={event => setProvider(event.target.value as ProviderFilter)}><option value="all">{copy("All providers", "所有提供方")}</option>{PROVIDERS.map(id => { const capability = capabilities.find(item => item.id === id); return <option key={id} value={id} disabled={Boolean(capability && !capability.history)}>{providerName(id)}{capability && !capability.history ? ` · ${capability.reason ?? copy("Unavailable", "不可用")}` : ""}</option>; })}</Select><Select aria-label={copy("Scan capacity", "扫描上限")} value={scanLimit} onChange={event => setScanLimit(Number(event.target.value))}><option value={80}>80</option><option value={100}>100</option></Select><Select aria-label={copy("History status", "历史状态")} value={status} onChange={event => { setStatus(event.target.value as StatusFilter); setPage(1); }}><option value="all">{copy("All records", "全部记录")}</option><option value="resumable">{copy("Ready to resume", "可恢复")}</option><option value="readOnly">{copy("Read-only", "只读")}</option><option value="owned">{copy("Bound records", "已绑定")}</option></Select></div>
    {issue && <div className="history-error" role="alert">{issue}{selected && !transcript && <button onClick={() => void read(selected)}>{copy("Retry read", "重试读取")}</button>}</div>}
    <div className="history-list history-native-list">{visible.map(item => <article className={selected?.provider === item.provider && selected.nativeId === item.nativeId ? "selected" : ""} key={`${item.provider}:${item.nativeId}`}><div><button className="history-row-main" onClick={() => void read(item)}><strong>{item.title}</strong><span>{providerName(item.provider)} · {formatDate(item.updatedAt)}</span><small>{displayPath(item.cwd) || copy("No recorded working directory", "未记录工作目录")}</small></button></div><div className="history-row-actions"><span className="history-state">{itemState(item)}</span><button onClick={() => void read(item)}>{copy("Read", "读取")}</button></div></article>)}{!loading && !visible.length && <p className="history-empty">{copy("No native history matches these filters.", "没有符合筛选条件的本机历史。")}</p>}</div>
    <footer className="history-pagination"><button disabled={currentPage <= 1} onClick={() => setPage(value => value - 1)}>{copy("Previous", "上一页")}</button><span>{currentPage} / {pages} · {filtered.length}</span><button disabled={currentPage >= pages} onClick={() => setPage(value => value + 1)}>{copy("Next", "下一页")}</button></footer>
    {selected && <section className="history-detail"><header><div><h3>{selected.title}</h3><p>{providerName(selected.provider)} · {displayPath(selected.cwd) || copy("No recorded directory", "未记录目录")}</p></div><span className="history-state">{itemState(selected)}</span></header><Transcript items={transcript} empty={copy("No structured transcript was returned.", "未返回结构化记录。")}/>{selectedOwner ? <section className="history-owner"><strong>{selectedOwner.readOnly ? copy("Imported read-only history", "已导入只读历史") : copy("Existing native owner", "现有本机会话")}</strong><p>{selectedOwner.readOnly ? copy("This saved transcript stays read-only until explicit resume.", "已保存的记录会保持只读，直到显式恢复。") : copy("This native identity is already owned.", "此本机身份已由现有会话拥有。")}</p><button onClick={() => void present(selectedOwner)} disabled={loading}>{copy("Open existing", "打开现有会话")}</button>{(selectedOwner.readOnly || !active(selectedOwner.status)) && selected.resumable && <button className="primary" onClick={() => setResumeCandidate(selectedOwner)} disabled={loading}>{copy("Resume explicitly", "显式恢复")}</button>}</section> : <section className="history-import"><strong>{copy("Import read-only card", "导入只读卡片")}</strong><p>{copy("This stores the captured transcript as a read-only card. It does not start an interactive session.", "此操作将捕获的记录保存为只读卡片，不会启动交互式会话。")}</p><label>{copy("Mode", "模式")}<Select value={mode} onChange={event => setMode(event.target.value as "terminal" | "chat")}><option value="terminal">{copy("Terminal", "终端")}</option>{selectedCapability?.chat && <option value="chat">{copy("Structured Chat", "结构化 Chat")}</option>}</Select></label><button onClick={() => void chooseCwd()}>{copy("Choose directory", "选择目录")}</button>{cwd && <small>{displayPath(cwd)}</small>}<button className="primary" onClick={() => void importCard()} disabled={loading}>{copy("Import card", "导入卡片")}</button></section>}{createdSessionId && <p className="history-created">{copy("Read-only history card:", "只读历史卡片：")}<code>{createdSessionId}</code>{createdSession && <button onClick={() => void present(createdSession)}>{copy("Open read-only card", "打开只读卡片")}</button>}</p>}</section>}{resumeCandidate && <SurfaceDialog title={copy("Resume native session", "恢复本机会话")} onClose={() => setResumeCandidate(undefined)} size="sm" footer={<><button onClick={() => setResumeCandidate(undefined)}>{copy("Cancel", "取消")}</button><button className="btn btn-primary" disabled={loading} onClick={() => void resume(resumeCandidate)}>{copy("Resume", "恢复")}</button></>}><p>{copy("Resume this provider session explicitly?", "是否显式恢复此提供方会话？")}</p><p><strong>{providerName(resumeCandidate.provider)} · {resumeCandidate.title}</strong></p><p className="mono dim-s">{displayPath(cwd ?? resumeCandidate.worktreePath ?? selected?.cwd) || copy("Choose a directory before resuming.", "恢复前请选择目录。")}</p>{!(cwd ?? resumeCandidate.worktreePath ?? selected?.cwd) && <button onClick={() => void chooseCwd()}>{copy("Choose directory", "选择目录")}</button>}</SurfaceDialog>}</aside>;
}

function Transcript({ items, empty }: { items?: ChatItem[]; empty: string }) { if (!items?.length) return <p className="history-transcript-empty">{empty}</p>; return <div className="history-transcript">{items.map(item => <article key={item.id}><strong>{item.role}</strong>{item.parts.map((part, index) => <div key={`${part.type}-${index}`}><small>{part.type}{part.toolName ? ` · ${part.toolName}` : ""}</small><pre>{detailText(part.text ?? part.data)}</pre></div>)}</article>)}</div>; }
