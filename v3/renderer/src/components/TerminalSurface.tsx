import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { WebLinksAddon } from '@xterm/addon-web-links';
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { openExternal, operationId, outputSubscription, request } from "../bridge";
import { acquireControl } from '../controlLease';
import { registerTerminalInputTarget } from '../terminalInputTargets';
import { useTranslation } from '../i18n';
import { displayPath } from "../projectScope";
import { terminalTheme } from '../terminalTheme';
import './terminal-surface.css';
import {BlockInspector} from './BlockInspector';
import { AgentIcon, Icon } from './PrototypeIcon';
import type { ProviderId, Session } from "@threadterm/protocol";
import {
  aiCompletionHintsEnabled,
  appendTerminalOutputTail,
  hasTentativeAiCompletionPrompt,
} from "./terminalCompletionHint";

type Props = { sessionId: string; provider: ProviderId; theme: "light" | "dark"; terminalCompatibility: unknown; session?: Session; onConfigure?: () => void; onCloseView?: () => void; onChanged?: () => void };
const providerLabel = (provider: ProviderId) => provider === "claude" ? "Claude Code" : provider === "codex" ? "Codex" : provider[0].toUpperCase() + provider.slice(1);
const isLive = (session?: Session) => Boolean(session && !session.readOnly && ["starting", "running", "idle", "waiting"].includes(session.status));

export function TerminalSurface({ sessionId, provider, theme, terminalCompatibility, session, onConfigure, onCloseView, onChanged }: Props) {
  const {locale} = useTranslation();
  const zh = locale === 'zh-CN';
  const host = useRef<HTMLDivElement>(null); const terminalRef = useRef<Terminal | undefined>(undefined);
  const controlRef = useRef<((enabled: boolean) => void) | undefined>(undefined);
  const [issue, setIssue] = useState<string>();
  const [unread, setUnread] = useState(0);
  const [selectedLink, setSelectedLink] = useState<string>();
  const [inspected, setInspected] = useState<string>();
  const [hasSelection,setHasSelection] = useState(false);
  const [completionHint, setCompletionHint] = useState(false);
  const completionHints = aiCompletionHintsEnabled(terminalCompatibility);
  const completionHintsRef = useRef(completionHints);
  const [actionBusy, setActionBusy] = useState(false);
  const canControl = isLive(session);
  useEffect(() => { completionHintsRef.current = completionHints; if (!completionHints) setCompletionHint(false); }, [completionHints]);
  useEffect(() => { if (terminalRef.current) terminalRef.current.options.theme = terminalTheme(theme); }, [theme]);
  useEffect(() => {
    const element = host.current; if (!element) return;
    let disposed = false; let unsubscribeOutput: (() => void) | undefined; let leaseEpoch: number | undefined; let releaseControl: (() => void) | undefined;
    let controlGeneration = 0;
    let lastResize: string | undefined;
    const terminal = new Terminal({ cursorBlink: true, fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: 13, lineHeight: 1.55, minimumContrastRatio: 4.5, scrollback: 10000, scrollOnEraseInDisplay: false, windowsPty: window.threadterm.windowsPty, theme: terminalTheme(theme) });
    terminalRef.current = terminal;
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element);
    terminal.loadAddon(new WebLinksAddon((_event, url) => setSelectedLink(url)));
    const selectionDisposable=terminal.onSelectionChange(()=>setHasSelection(terminal.hasSelection()));
    const scrollDisposable = terminal.onScroll(() => {
      if (terminal.buffer.active.viewportY >= terminal.buffer.active.baseY) setUnread(0);
    });
    terminal.options.disableStdin = true; setIssue(undefined); setCompletionHint(false);
    const resize = () => {
      if (disposed || element.clientWidth === 0 || element.clientHeight === 0) return;
      try {
        fit.fit();
        if (!leaseEpoch) return;
        const size = `${leaseEpoch}:${terminal.cols}:${terminal.rows}`;
        if (lastResize === size) return;
        lastResize = size;
        void request('terminal.resize', { sessionId, cols: terminal.cols, rows: terminal.rows, leaseEpoch }).catch(() => {
          if (lastResize === size) lastResize = undefined;
        });
      } catch { /* xterm host is not yet measurable. */ }
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const dataDisposable = terminal.onData((data) => { if (leaseEpoch && !disposed) void request("terminal.input", { sessionId, data, leaseEpoch }).catch((error: unknown) => !disposed && setIssue(error instanceof Error ? error.message : "Input was rejected.")); });
    const unregisterInput = registerTerminalInputTarget(sessionId, { visible: () => !disposed && element.getClientRects().length > 0, insert: text => {
      if (!leaseEpoch || disposed || terminal.options.disableStdin) throw new Error('terminal_control_unavailable');
      terminal.focus(); terminal.paste(text);
    } });
    const setControl = (enabled: boolean) => {
      const generation = ++controlGeneration;
      releaseControl?.(); releaseControl = undefined; leaseEpoch = undefined; lastResize = undefined;
      if (!disposed) terminal.options.disableStdin = true;
      if (!enabled || disposed) return;
      void acquireControl(sessionId, () => {
        if (!disposed && generation === controlGeneration) {leaseEpoch = undefined; terminal.options.disableStdin = true; setIssue('Terminal control expired. Reopen the session to reacquire it.');}
      }).then(claim => {
        if (disposed || generation !== controlGeneration) {claim.release(); return;}
        releaseControl = claim.release; leaseEpoch = claim.epoch; terminal.options.disableStdin = false; resize(); terminal.focus();
      }).catch(error => {if (!disposed && generation === controlGeneration) setIssue(`Read-only view: ${error instanceof Error ? error.message : String(error)}`);});
    };
    controlRef.current = setControl;
    void (async () => {
      try {
        const decoder = new TextDecoder();
        let outputTail = "";
        const lateSubscription = await outputSubscription(sessionId, 0, (chunk) => {
          if (disposed) return;
          if (chunk.gap) setIssue("Some older terminal output is no longer available. Live output continues.");
          if (chunk.data.byteLength) {
            if (completionHintsRef.current) {
              outputTail = appendTerminalOutputTail(
                outputTail,
                decoder.decode(chunk.data, { stream: true }),
              );
              setCompletionHint(hasTentativeAiCompletionPrompt(provider, outputTail));
            }
            const reading = terminal.buffer.active.viewportY < terminal.buffer.active.baseY;
            return new Promise<void>((resolve) => terminal.write(chunk.data, () => {
              if (reading && !disposed) setUnread(value => value + 1);
              resolve();
            }));
          }
        });
        if (disposed) { lateSubscription(); return; }
        unsubscribeOutput = lateSubscription;
      } catch (error) { if (!disposed) setIssue(error instanceof Error ? error.message : "Terminal could not connect."); }
    })();
    return () => { disposed = true; setControl(false); unregisterInput(); observer.disconnect(); dataDisposable.dispose(); scrollDisposable.dispose(); selectionDisposable.dispose(); unsubscribeOutput?.(); terminal.dispose(); if (terminalRef.current === terminal) terminalRef.current = undefined; if (controlRef.current === setControl) controlRef.current = undefined; };
  }, [provider, sessionId]);
  useEffect(() => {
    const setControl = controlRef.current;
    setControl?.(canControl);
    return () => setControl?.(false);
  }, [canControl, provider, sessionId]);
  const toggleFollow = async () => {
    if (!session || actionBusy) return;
    setActionBusy(true);
    try { await request("session.update", { sessionId, followed: !session.followed, operationId: operationId() }); onChanged?.(); }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)); }
    finally { setActionBusy(false); }
  };
  const stop = async () => {
    if (!isLive(session) || actionBusy) return;
    setActionBusy(true);
    try { await request("session.stop", { sessionId, operationId: operationId() }); onChanged?.(); }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)); }
    finally { setActionBusy(false); }
  };
  const rerun = async () => {
    if (!session || session.readOnly || actionBusy) return;
    setActionBusy(true);
    try { await request("session.rerun", { sessionId, operationId: operationId() }); onChanged?.(); }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)); }
    finally { setActionBusy(false); }
  };
  const title = session?.title ?? providerLabel(provider);
  const provenance = canControl
    ? (zh ? "实时输出 · 本地会话" : "Live output · local session")
    : session?.readOnly
      ? (zh ? "已保存记录 · 只读" : "Saved record · read-only")
      : (zh ? "历史输出 · 已结束" : "History output · ended");
  return <div className="terminal-wrap term"><header className="term-head"><b>{title}</b><span className="grow demo">{providerLabel(provider)} · {provenance}</span><button className={`btn-ghost icon-btn star${session?.followed ? " on" : ""}`} disabled={!session || actionBusy} aria-label={session?.followed ? (zh ? "取消关注" : "Unfollow") : (zh ? "关注" : "Follow")} aria-pressed={Boolean(session?.followed)} onClick={() => void toggleFollow()}>{session?.followed ? "★" : "☆"}</button>{isLive(session) && <button className="btn-ghost btn term-stop" disabled={actionBusy} onClick={() => void stop()}>{zh ? "结束会话" : "End session"}</button>}<span hidden={!issue} className="term-read-state">{issue ? (zh ? '需要注意' : 'Attention') : session?.readOnly ? (zh ? "只读" : "Read-only") : (zh ? '已连接' : 'Connected')}</span></header><div className="v3-session-controls"><span className="v3-mode">{session?.mode === "chat" ? (zh ? "聊天" : "Chat") : "Terminal · " + (zh ? "交互式" : "interactive")}</span><span className="grow" />{onCloseView && <button className="btn" onClick={onCloseView}>{zh ? "关闭视图" : "Close view"}</button>}{onConfigure && <button className="btn" onClick={onConfigure}>{zh ? "配置" : "Configure"}</button>}{session && !session.readOnly && <button className="btn" disabled={actionBusy} onClick={() => void rerun()}>{zh ? "再次运行" : "Rerun"}</button>}</div><div className="terminal-host term-output" ref={host} aria-label={zh ? '实时终端输出' : 'Live terminal output'} />
    {hasSelection&&<button className="terminal-inspect-selection" onClick={()=>setInspected(terminalRef.current?.getSelection()??'')}>{zh?'检查选区':'Inspect selection'}</button>}
    {inspected!==undefined&&<BlockInspector sessionId={sessionId} text={inspected} onClose={()=>setInspected(undefined)}/>}
    {unread > 0 && <button className="terminal-new-output" onClick={() => {terminalRef.current?.scrollToBottom();setUnread(0);}}>{zh ? `${unread} 批新输出 · 回到底部` : `${unread} new updates · Back to bottom`}</button>}
    {completionHints && completionHint && <p className="terminal-completion-hint" role="status">{zh ? "可能已准备好输入" : "Possibly ready for input"}</p>}
    {selectedLink && <div className="terminal-link-actions"><span title={selectedLink}>{selectedLink}</span><button onClick={() => void openExternal(selectedLink).catch(error => setIssue(String(error)))}>{zh ? '在浏览器中打开' : 'Open in browser'}</button><button onClick={() => void navigator.clipboard.writeText(selectedLink).catch(error => setIssue(String(error)))}>{zh ? '复制链接' : 'Copy link'}</button><button onClick={() => setSelectedLink(undefined)}>{zh ? '关闭' : 'Close'}</button></div>}
    {issue && <div className="surface-error" role="alert">{issue}</div>}
    {session?.status === "starting" && <div className="term-starting" role="status" aria-live="polite"><div className="spinner" /><strong>{zh ? "正在启动终端…" : "Starting terminal…"}</strong></div>}
    <footer className="term-foot">{session?.worktreePath ? `${zh ? "工作目录" : "Working directory"} · ${displayPath(session.worktreePath)}` : (zh ? "返回工作台不会关闭会话" : "Returning to the workspace does not close the session")}</footer></div>;
}
