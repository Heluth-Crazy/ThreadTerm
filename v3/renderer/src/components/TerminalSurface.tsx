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
import { AgentLoadingMark } from './AgentLoadingMark';
import type { ProviderId, Session, TerminalLaunchState } from "@threadterm/protocol";
import {
  aiCompletionHintsEnabled,
  appendTerminalOutputTail,
  hasTentativeAiCompletionPrompt,
} from "./terminalCompletionHint";

type Props = { sessionId: string; provider: ProviderId; theme: "light" | "dark"; terminalCompatibility: unknown; session?: Session; onConfigure?: () => void; onCloseView?: () => void; onChanged?: () => void; onOpenSession?: (id: string) => void; resumeCapture?: "preassigned" | "none" };
const providerLabel = (provider: ProviderId) => provider === "claude" ? "Claude Code" : provider === "codex" ? "Codex" : provider[0].toUpperCase() + provider.slice(1);
const isLive = (session?: Session) => Boolean(session && !session.readOnly && ["starting", "running", "idle", "waiting"].includes(session.status));
// Raw PTY logs can contain hours of animation, not merely conversation text.
// Bound each read, not the history prefix needed by the terminal parser.
const REPLAY_PAGE_BYTES = 1024 * 1024;
const REPLAY_STALL_MS = 15_000;
const hasVisibleTerminalFrame = (terminal: Terminal) => {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true).trim() ?? "").some(Boolean);
};

export function TerminalSurface({ sessionId, provider, theme, terminalCompatibility, session, onConfigure, onCloseView, onChanged, onOpenSession, resumeCapture }: Props) {
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
  const [resuming, setResuming] = useState(false);
  const [launch, setLaunch] = useState<TerminalLaunchState | undefined>();
  const [launchReadIssue, setLaunchReadIssue] = useState<string>();
  const [launchAttempt, setLaunchAttempt] = useState(0);
  const [startupFrameSeen, setStartupFrameSeen] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const startupFrameSeenRef = useRef(false);
  const renderedOutputCursorRef = useRef(0);
  const startupFrameFloorRef = useRef<number | undefined>(undefined);
  const resumeFramePendingRef = useRef(false);
  const resumeFrameProbeRef = useRef<Terminal | undefined>(undefined);
  const startupGenerationRef = useRef<{ sessionId: string; attempt: number; status?: Session["status"] } | undefined>(undefined);
  // A durable byte watermark, not an idle timer, separates historical repaint
  // traffic from live interaction. Keep the host measurable but invisible until
  // xterm has consumed it. Never send historical terminal query replies to a PTY.
  const replayKey = `${provider}:${sessionId}`;
  const [replay, setReplay] = useState(() => ({ key: replayKey, phase: "catching" as "catching" | "ready" | "failed" }));
  const [replayAttempt, setReplayAttempt] = useState(0);
  if (replay.key !== replayKey) setReplay({ key: replayKey, phase: "catching" });
  const replaying = replay.key !== replayKey || replay.phase === "catching";
  const replayFailed = replay.key === replayKey && replay.phase === "failed";
  // A reserved resume is starting before its PTY exists. Acquire control only
  // once running, otherwise a premature resize fails and is never retriggered.
  const canControl = replay.phase === "ready" && isLive(session) && session?.status !== "starting";
  const startupLaunchPending = provider === "codex" && session?.mode === "terminal"
    && (resuming || (isLive(session)
      && (launch?.phase === "preparing" || launch?.phase === "launching" || launch?.phase === "running" || (!launch && session?.status === "starting"))));
  const recordedCols = session?.cols, recordedRows = session?.rows;
  const fixedSize = !canControl && typeof recordedCols === "number" && typeof recordedRows === "number"
    && Number.isInteger(recordedCols) && Number.isInteger(recordedRows) && recordedCols > 0 && recordedRows > 0
    ? { cols: recordedCols, rows: recordedRows }
    : undefined;
  // The mount effect below is captured once per session; read the CURRENT
  // fixedSize through a ref so a resumed session leaves fixed-geometry replay
  // and rejoins live fitting/resizing instead of staying frozen.
  const fixedSizeRef = useRef(fixedSize);
  useEffect(() => { fixedSizeRef.current = fixedSize; }, [fixedSize]);
  const canControlRef = useRef(canControl);
  // The banner belongs to opening a legacy replay. A session that was live in this surface
  // keeps its built frame when it ends (the banner would shrink the host and reflow the
  // viewport), so the latch is keyed by session and adjusted during render on switches.
  const [sawControl, setSawControl] = useState(() => ({ key: `${provider}:${sessionId}`, value: canControl }));
  if (sawControl.key !== `${provider}:${sessionId}`) {
    setSawControl({ key: `${provider}:${sessionId}`, value: canControl });
  } else if (canControl && !sawControl.value) {
    setSawControl({ key: sawControl.key, value: true });
  }
  const unknownGeometry = Boolean(session) && !isLive(session) && !fixedSize && !sawControl.value;
  useEffect(() => { completionHintsRef.current = completionHints; if (!completionHints) setCompletionHint(false); }, [completionHints]);
  useEffect(() => {
    const previous = startupGenerationRef.current;
    const enteringStarting = previous?.status !== "starting" && session?.status === "starting";
    const newSession = previous?.sessionId !== sessionId;
    const retry = previous?.attempt !== launchAttempt;
    if (newSession || retry || enteringStarting) {
      startupFrameSeenRef.current = false; setStartupFrameSeen(false);
      if (newSession) { renderedOutputCursorRef.current = 0; resumeFramePendingRef.current = false; }
      // An in-place resume already has an xterm buffer: only later output may
      // reveal a new native frame. A newly mounted starting session sets its
      // durable floor after terminal.read below.
      startupFrameFloorRef.current = newSession && session?.status === "starting" ? undefined
        : newSession ? renderedOutputCursorRef.current
          : Math.max(startupFrameFloorRef.current ?? 0, renderedOutputCursorRef.current);
    }
    startupGenerationRef.current = { sessionId, attempt: launchAttempt, status: session?.status };
  }, [session?.status, sessionId, launchAttempt]);
  useEffect(() => { if (terminalRef.current) terminalRef.current.options.theme = terminalTheme(theme); }, [theme]);
  useEffect(() => {
    const element = host.current; if (!element) return;
    let disposed = false; let unsubscribeOutput: (() => void) | undefined; let leaseEpoch: number | undefined; let releaseControl: (() => void) | undefined;
    let replayAborted = false;
    let replayTimer: number | undefined;
    let replayCursor = 0;
    let replayLastProgress = Date.now();
    const failReplay = (message: string) => {
      if (disposed || replayComplete || replayAborted) return;
      replayAborted = true;
      window.clearInterval(replayTimer);
      for (const settle of pendingWrites) settle();
      unsubscribeOutput?.(); unsubscribeOutput = undefined;
      setIssue(message);
      setReplay({ key: replayKey, phase: "failed" });
    };
    const pendingWrites = new Set<() => void>();
    let controlGeneration = 0;
    let lastResize: string | undefined;
    let resizeRetried: string | undefined;
    const resizeFailureNote = "Terminal resize was rejected; the provider may keep using the previous size until the next successful resize.";
    const terminal = new Terminal({ ...(fixedSize ? { cols: fixedSize.cols, rows: fixedSize.rows } : {}), cursorBlink: true, fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: 13, lineHeight: 1.55, minimumContrastRatio: 4.5, scrollback: 10000, scrollOnEraseInDisplay: false, windowsPty: window.threadterm.windowsPty, theme: terminalTheme(theme) });
    terminalRef.current = terminal;
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element);
    const noteRenderedStartupFrame = (cursor: number, chunk: import("@threadterm/protocol").OutputChunk) => {
      // This is presentation evidence only, never a claim that Codex is ready:
      // wait until a post-launch byte has actually rendered a non-empty xterm
      // frame, so authentication/trust prompts become visible immediately.
      if (startupFrameSeenRef.current) return;
      const floor = startupFrameFloorRef.current;
      if (floor !== undefined && cursor <= floor) return;
      const probe = resumeFrameProbeRef.current;
      if (resumeFramePendingRef.current && probe) {
        // An independent parser starts at the native run boundary. Old screen
        // cells and cursor-only startup escapes cannot count as a new frame.
        const offset = Math.max(0, (floor ?? chunk.cursor) - chunk.cursor);
        probe.write(chunk.data.subarray(offset), () => {
          if (disposed || resumeFrameProbeRef.current !== probe || !hasVisibleTerminalFrame(probe)) return;
          resumeFramePendingRef.current = false;
          startupFrameSeenRef.current = true; setStartupFrameSeen(true);
          resumeFrameProbeRef.current = undefined; probe.dispose();
        });
        return;
      }
      if (!hasVisibleTerminalFrame(terminal)) return;
      resumeFramePendingRef.current = false;
      startupFrameSeenRef.current = true; setStartupFrameSeen(true);
    };
    terminal.loadAddon(new WebLinksAddon((_event, url) => setSelectedLink(url)));
    const selectionDisposable=terminal.onSelectionChange(()=>setHasSelection(terminal.hasSelection()));
    const scrollDisposable = terminal.onScroll(() => {
      if (terminal.buffer.active.viewportY >= terminal.buffer.active.baseY) setUnread(0);
    });
    terminal.options.disableStdin = true; setIssue(undefined); setCompletionHint(false);
    // Legacy records have no trustworthy geometry. Keep their documented
    // best-effort current-pane replay instead of inventing an 80x24 history.
    if (!fixedSize) { try { fit.fit(); } catch { /* host may not be measurable yet */ } }
    const resize = () => {
      if (disposed || element.clientWidth === 0 || element.clientHeight === 0) return;
      if (!replayComplete) return;
      if (fixedSizeRef.current) return;
      try {
        fit.fit();
        if (!leaseEpoch) return;
        const size = `${leaseEpoch}:${terminal.cols}:${terminal.rows}`;
        if (lastResize === size) return;
        lastResize = size;
        void request('terminal.resize', { sessionId, cols: terminal.cols, rows: terminal.rows, leaseEpoch }).then(() => {
          if (disposed) return;
          resizeRetried = undefined;
          setIssue(current => current === resizeFailureNote ? undefined : current);
        }, () => {
          if (disposed) return;
          if (lastResize === size) lastResize = undefined;
          if (resizeRetried === size) { setIssue(current => current ?? resizeFailureNote); return; }
          // Re-validate once after the layout settles so a failed final resize is not lost.
          resizeRetried = size;
          requestAnimationFrame(() => resize());
        });
      } catch { /* xterm host is not yet measurable. */ }
    };
    let replayComplete = false;
    const observer = new ResizeObserver(resize); observer.observe(element);
    const dataDisposable = terminal.onData((data) => { if (leaseEpoch && !disposed) void request("terminal.input", { sessionId, data, leaseEpoch }).catch((error: unknown) => !disposed && setIssue(error instanceof Error ? error.message : "Input was rejected.")); });
    const unregisterInput = registerTerminalInputTarget(sessionId, { visible: () => !disposed && element.getClientRects().length > 0, insert: text => {
      if (!leaseEpoch || disposed || terminal.options.disableStdin) throw new Error('terminal_control_unavailable');
      terminal.focus(); terminal.paste(text);
    } });
    const setControl = (enabled: boolean) => {
      const generation = ++controlGeneration;
      releaseControl?.(); releaseControl = undefined; leaseEpoch = undefined; lastResize = undefined; resizeRetried = undefined;
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
    replayTimer = window.setInterval(() => {
      if (!replayComplete && Date.now() - replayLastProgress >= REPLAY_STALL_MS) {
        failReplay(zh ? `终端回放已停止推进（游标 ${replayCursor}）。请重试恢复画面；原始历史未改动。` : `Terminal replay stopped advancing at byte ${replayCursor}. Retry screen recovery; retained history is unchanged.`);
      }
    }, 1000);
    void (async () => {
      try {
        const decoder = new TextDecoder();
        let outputTail = "";
        const boundary = await request('terminal.read', { sessionId, tail: true, limit: 1 });
        if (disposed || replayAborted) return;
        const replayEnd = boundary.nextCursor;
        if (!Number.isSafeInteger(replayEnd) || replayEnd < 0) throw new Error("Terminal replay returned an invalid history boundary.");
        // ANSI and UTF-8 are stateful across arbitrary byte boundaries. Until
        // we have a real terminal checkpoint, every replay must begin at zero.
        const replayStart = 0;
        const pagedReplay = replayEnd > REPLAY_PAGE_BYTES;
        let replaySubscribed = false;
        replayCursor = replayStart;
        replayLastProgress = Date.now();
        if (session?.status === "starting" && startupFrameFloorRef.current === undefined) startupFrameFloorRef.current = replayEnd;
        const finishReplay = () => {
          if (disposed || replayAborted || replayComplete || !replaySubscribed) return;
          replayComplete = true;
          window.clearInterval(replayTimer);
          if (!canControlRef.current) terminal.write("\x1b[?25l", () => { if (!disposed) terminal.refresh(0, terminal.rows - 1); });
          setReplay({ key: replayKey, phase: "ready" });
          requestAnimationFrame(resize);
        };
        const consume = (chunk: import("@threadterm/protocol").OutputChunk) => {
          if (disposed || replayAborted) return;
          if (chunk.gap) {
            if (!replayComplete) {
              failReplay(zh ? "历史输出存在缺口，无法完整恢复此片段。原始记录未改动。" : "Historical output has a gap; this replay segment cannot be restored completely. Retained history is unchanged.");
              return;
            }
            setIssue("Some older terminal output is no longer available. Live output continues.");
          }
          if (chunk.data.byteLength) {
            if (completionHintsRef.current) {
              outputTail = appendTerminalOutputTail(
                outputTail,
                decoder.decode(chunk.data, { stream: true }),
              );
              setCompletionHint(hasTentativeAiCompletionPrompt(provider, outputTail));
            }
            const reading = terminal.buffer.active.viewportY < terminal.buffer.active.baseY;
            return new Promise<void>((resolve) => {
              let settled = false;
              const settle = () => { if (!settled) { settled = true; pendingWrites.delete(settle); resolve(); } };
              pendingWrites.add(settle);
              terminal.write(chunk.data, () => {
                if (disposed || replayAborted) { settle(); return; }
                const advanced = Math.min(replayEnd, chunk.cursor + chunk.data.byteLength);
                if (advanced > replayCursor) {
                  replayCursor = advanced;
                  replayLastProgress = Date.now();
                }
                renderedOutputCursorRef.current = Math.max(renderedOutputCursorRef.current, chunk.cursor + chunk.data.byteLength);
                noteRenderedStartupFrame(chunk.cursor + chunk.data.byteLength, chunk);
                if (replayComplete && !canControlRef.current) terminal.write("\x1b[?25l", () => { if (!disposed) terminal.refresh(0, terminal.rows - 1); });
                if (reading) setUnread(value => value + 1);
                if (chunk.cursor + chunk.data.byteLength >= replayEnd) finishReplay();
                settle();
              });
            });
          }
          if (chunk.cursor >= replayEnd) finishReplay();
        };
        // Page the complete stream without discarding parser state or original
        // bytes. Bounded indexed reads avoid one IPC/ACK per tiny animation
        // chunk. Joining at the captured end preserves concurrent live output.
        if (pagedReplay) {
          let cursor = replayStart;
          while (cursor < replayEnd && !disposed && !replayAborted) {
            const limit = Math.min(REPLAY_PAGE_BYTES, replayEnd - cursor);
            const page = await request('terminal.read', { sessionId, cursor, limit });
            if (disposed || replayAborted) return;
            const binary = atob(page.data);
            const data = new Uint8Array(binary.length);
            // Avoid a per-character iterator/callback allocation across large
            // histories; this still copies every decoded byte verbatim.
            for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
            if (page.fromCursor !== cursor || data.length === 0 || data.length > limit || page.nextCursor !== cursor + data.length) {
              throw new Error("Terminal history did not advance contiguously; retry screen recovery.");
            }
            await consume({ sessionId, cursor, data });
            cursor = page.nextCursor;
          }
        }
        if (disposed || replayAborted) return;
        const lateSubscription = await outputSubscription(sessionId, pagedReplay ? replayEnd : 0, consume);
        if (disposed || replayAborted) { lateSubscription(); return; }
        unsubscribeOutput = lateSubscription;
        replaySubscribed = true;
        if (replayCursor >= replayEnd) finishReplay();
      } catch (error) {
        failReplay(error instanceof Error ? error.message : "Terminal could not connect.");
      }
    })();
    return () => { disposed = true; resumeFrameProbeRef.current?.dispose(); resumeFrameProbeRef.current = undefined; window.clearInterval(replayTimer); for (const settle of pendingWrites) settle(); setControl(false); unregisterInput(); observer.disconnect(); dataDisposable.dispose(); scrollDisposable.dispose(); selectionDisposable.dispose(); unsubscribeOutput?.(); terminal.dispose(); if (terminalRef.current === terminal) terminalRef.current = undefined; if (controlRef.current === setControl) controlRef.current = undefined; };
  }, [provider, sessionId, replayAttempt]);
  useEffect(() => {
    const setControl = controlRef.current;
    setControl?.(canControl);
    return () => setControl?.(false);
  }, [canControl, provider, sessionId]);
  useEffect(() => {
    canControlRef.current = canControl;
    // Ended/read-only surfaces replay history: hide the host cursor on this local
    // presentation instance only (never persisted, subscribed bytes stay untouched).
    const terminal = terminalRef.current;
    if (!terminal) return;
    // A resumed session returns to live: undo the replay cursor hiding.
    if (canControl) { terminal.write("\x1b[?25h"); return; }
    terminal.write("\x1b[?25l", () => { if (terminalRef.current === terminal) terminal.refresh(0, terminal.rows - 1); });
  }, [canControl]);
  // Deferred Codex creation owns a durable launch record. Polling is limited to
  // its short-lived pending phases; old/synchronous sessions deliberately ignore
  // the unavailable error instead of being recast as deferred launches.
  useEffect(() => {
    setLaunch(undefined); setLaunchReadIssue(undefined); setShowTerminal(false);
    if (provider !== "codex" || session?.mode !== "terminal") return;
    let disposed = false; let timer: number | undefined; let sawDeferredPending = false;
    const poll = async () => {
      try {
        const next = await request("session.launch.read", { sessionId });
        if (disposed) return;
        setLaunch(next); setLaunchReadIssue(undefined);
        if (next.phase === "preparing" || next.phase === "launching") {
          sawDeferredPending = true;
          timer = window.setTimeout(() => void poll(), 500);
        }
      } catch (error) {
        // A legacy/synchronous terminal has no deferred-launch record. Its
        // normal session status remains the source of truth.
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("session_launch_unavailable")) return;
        if ((sawDeferredPending || session?.status === "starting") && !disposed) {
          setLaunchReadIssue(message || "Unable to check terminal startup.");
          timer = window.setTimeout(() => void poll(), 1000);
        }
      }
    };
    void poll();
    return () => { disposed = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [provider, session?.mode, session?.status, sessionId, launchAttempt]);
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
    try {
      // A rerun is a NEW conversation with the saved launch configuration;
      // switch the view to it instead of leaving the ended session on screen.
      const created = await request("session.rerun", { sessionId, operationId: operationId() });
      onChanged?.();
      if (created.id !== sessionId) onOpenSession?.(created.id);
    }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)); }
    finally { setActionBusy(false); }
  };
  const resume = async () => {
    if (!session || session.readOnly || isLive(session) || actionBusy) return;
    setActionBusy(true); setResuming(true); setIssue(undefined);
    try {
      if (provider === "codex") {
        // Old history is not evidence that the NEW native CLI can accept
        // input. Keep its loading mark until bytes beyond the stopped log
        // have rendered, including when Resume is clicked during catch-up.
        setShowTerminal(false); setStartupFrameSeen(false);
        startupFrameSeenRef.current = false;
        resumeFramePendingRef.current = true;
        startupFrameFloorRef.current = Number.POSITIVE_INFINITY;
        const boundary = await request('terminal.read', { sessionId, tail: true, limit: 1 });
        if (!Number.isSafeInteger(boundary.nextCursor) || boundary.nextCursor < 0) throw new Error('Invalid resume output boundary');
        startupFrameFloorRef.current = boundary.nextCursor;
        resumeFrameProbeRef.current?.dispose();
        resumeFrameProbeRef.current = new Terminal({ cols: terminalRef.current?.cols ?? 80, rows: terminalRef.current?.rows ?? 24, scrollback: 0 });
      }
      // Native resume keeps this sessionId and its retained output; the next
      // snapshot refresh turns this same surface back into the live terminal.
      await request("session.resume", { sessionId, operationId: operationId() });
      onChanged?.();
    }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)); }
    finally { setActionBusy(false); setResuming(false); }
  };
  const retryDeferredLaunch = async () => {
    if (!session || actionBusy || launch?.phase !== "failed") return;
    setActionBusy(true); setResuming(true); setIssue(undefined); setShowTerminal(false); setStartupFrameSeen(false); startupFrameSeenRef.current = false;
    try {
      await request("session.resume", { sessionId, operationId: operationId() });
      setLaunch({ phase: "preparing" }); setLaunchReadIssue(undefined); setLaunchAttempt(value => value + 1); onChanged?.();
    } catch (error) { setIssue(error instanceof Error ? error.message : String(error)); }
    finally { setActionBusy(false); setResuming(false); }
  };
  const agentProvider = provider !== "shell" && provider !== "custom";
  const ended = Boolean(session) && !isLive(session);
  const deferredRetry = provider === "codex" && (launch?.phase === "failed" || launch?.phase === "cancelled");
  const resumeBlocked = agentProvider && ended && !session?.nativeId && !deferredRetry
    ? (resumeCapture === "none"
      ? (zh ? "该 Provider 的终端会话不支持原生恢复" : "This provider's terminal sessions cannot be resumed natively")
      : (zh ? "该记录缺少原生会话标识，无法确认原对话。请新建会话。" : "This record has no native conversation identity. Start a new session to continue."))
    : undefined;
  const title = session?.title ?? providerLabel(provider);
  const reportedLaunch = launch ?? (provider === "codex" && session?.mode === "terminal" && session?.status === "starting" ? { phase: "preparing" as const } : undefined);
  const launchPending = startupLaunchPending && !startupFrameSeen;
  const launchFailed = reportedLaunch?.phase === "failed";
  useEffect(() => {
    // A newly mounted terminal can receive its first native frame before the
    // replay-boundary request returns. Once the runtime has actually advanced
    // from its starting reservation to running, that rendered frame is enough
    // to hand off presentation; it still says nothing about model readiness.
    const terminal = terminalRef.current;
    if (provider !== "codex" || !startupLaunchPending || startupFrameSeen || launch?.phase !== "running" || session?.status === "starting" || !terminal || !hasVisibleTerminalFrame(terminal)) return;
    if (resumeFramePendingRef.current) return;
    resumeFramePendingRef.current = false;
    startupFrameSeenRef.current = true; setStartupFrameSeen(true);
  }, [launch?.phase, provider, session?.status, startupFrameSeen, startupLaunchPending]);
  const loadingStatus = replaying
    ? (zh ? "正在恢复终端画面…" : "Restoring terminal screen…")
    : launchFailed
      ? (reportedLaunch?.error?.message || (zh ? "终端启动失败。" : "Terminal startup failed."))
      : reportedLaunch?.phase === "preparing"
        ? (zh ? "正在准备 Codex 会话…" : "Preparing Codex session…")
        : (zh ? "正在等待 Codex 终端画面…" : "Waiting for the Codex terminal screen…");
  const provenance = replaying
    ? (zh ? "本地会话" : "Local session")
    : session?.status === "starting"
    ? (zh ? "正在启动 · 本地会话" : "Starting · local session")
    : canControl
    ? (zh ? "实时输出 · 本地会话" : "Live output · local session")
    : session?.readOnly
      ? (zh ? "已保存记录 · 只读" : "Saved record · read-only")
      : (zh ? "历史输出 · 已结束" : "History output · ended");
  return <div className="terminal-wrap term"><header className="term-head"><b>{title}</b><span className="grow demo">{providerLabel(provider)} · {provenance}</span><button className={`btn-ghost icon-btn star${session?.followed ? " on" : ""}`} disabled={!session || actionBusy} aria-label={session?.followed ? (zh ? "取消关注" : "Unfollow") : (zh ? "关注" : "Follow")} aria-pressed={Boolean(session?.followed)} onClick={() => void toggleFollow()}>{session?.followed ? "★" : "☆"}</button>{isLive(session) && <button className="btn-ghost btn term-stop" disabled={actionBusy} onClick={() => void stop()}>{zh ? "结束会话" : "End session"}</button>}<span hidden={!issue} className="term-read-state">{issue ? (zh ? '需要注意' : 'Attention') : session?.readOnly ? (zh ? "只读" : "Read-only") : (zh ? '已连接' : 'Connected')}</span></header><div className="v3-session-controls"><span className="v3-mode">{session?.mode === "chat" ? (zh ? "聊天" : "Chat") : "Terminal · " + (ended ? (zh ? "历史只读" : "read-only history") : (zh ? "交互式" : "interactive"))}</span><span className="grow" />{launchPending && !replaying && !showTerminal && <button type="button" className="btn" onClick={() => setShowTerminal(true)}>{zh ? "显示终端" : "Show terminal"}</button>}{onCloseView && <button className="btn" onClick={onCloseView}>{zh ? "关闭视图" : "Close view"}</button>}{onConfigure && <button className="btn" onClick={onConfigure}>{zh ? "配置" : "Configure"}</button>}{session && !session.readOnly && ended && agentProvider && <button className="btn btn-primary" disabled={actionBusy || Boolean(resumeBlocked)} title={resumeBlocked ?? (zh ? "通过 Provider 原生机制恢复原对话" : "Resume the original conversation natively")} onClick={() => void resume()}>{resuming ? (zh ? "恢复中…" : "Resuming…") : (zh ? "继续会话" : "Resume")}</button>}{session && !session.readOnly && ended && agentProvider && <button className="btn" disabled={actionBusy} title={zh ? "沿用保存的配置开始全新对话" : "Start a fresh conversation with the saved configuration"} onClick={() => void rerun()}>{zh ? "新建同配置会话" : "New with same config"}</button>}{session && !session.readOnly && ended && !agentProvider && <button className="btn" disabled={actionBusy} onClick={() => void rerun()}>{zh ? "重新执行" : "Run again"}</button>}</div>{unknownGeometry && <p className="term-legacy-note" role="status">{zh ? "该历史会话未记录终端尺寸，部分全屏界面可能错位。重新运行可生成可稳定回放的新记录。" : "This historical session has no recorded terminal size; full-screen interfaces may be misaligned. Rerun it to create a new record that replays reliably."}</p>}{resumeBlocked && <p className="term-resume-note" role="note">{resumeBlocked}</p>}<div className="term-content"><div className={`terminal-host term-output${fixedSize ? " fixed-geometry" : ""}`} ref={host} aria-label={zh ? '实时终端输出' : 'Live terminal output'} />
    {hasSelection&&<button className="terminal-inspect-selection" onClick={()=>setInspected(terminalRef.current?.getSelection()??'')}>{zh?'检查选区':'Inspect selection'}</button>}
    {inspected!==undefined&&<BlockInspector sessionId={sessionId} text={inspected} onClose={()=>setInspected(undefined)}/>}
    {unread > 0 && <button className="terminal-new-output" onClick={() => {terminalRef.current?.scrollToBottom();setUnread(0);}}>{zh ? `${unread} 批新输出 · 回到底部` : `${unread} new updates · Back to bottom`}</button>}
    {completionHints && completionHint && <p className="terminal-completion-hint" role="status">{zh ? "可能已准备好输入" : "Possibly ready for input"}</p>}
    {selectedLink && <div className="terminal-link-actions"><span title={selectedLink}>{selectedLink}</span><button onClick={() => void openExternal(selectedLink).catch(error => setIssue(String(error)))}>{zh ? '在浏览器中打开' : 'Open in browser'}</button><button onClick={() => void navigator.clipboard.writeText(selectedLink).catch(error => setIssue(String(error)))}>{zh ? '复制链接' : 'Copy link'}</button><button onClick={() => setSelectedLink(undefined)}>{zh ? '关闭' : 'Close'}</button></div>}
    {issue && <div className="surface-error" role="alert">{issue}</div>}
    {(replaying || replayFailed || launchFailed || (launchPending && !showTerminal)) && <div className={`term-loading-overlay${replaying ? " term-replaying" : ""}${replayFailed || launchFailed ? " is-failed" : ""}`} role={replayFailed || launchFailed ? "alert" : "status"} aria-live="polite" aria-label={loadingStatus}>
      <div className="chat-connect-center">
        <AgentLoadingMark provider={provider} active={!replayFailed && !launchFailed} />
        {(replayFailed || launchFailed) && <p className="chat-connect-status">{replayFailed ? (zh ? "终端画面恢复失败。" : "Terminal screen recovery failed.") : loadingStatus}</p>}
        {replayFailed && issue && <p className="chat-connect-hint">{issue}</p>}
        {replayFailed && <button type="button" className="btn" onClick={() => { setIssue(undefined); setReplay({ key: replayKey, phase: "catching" }); setReplayAttempt(value => value + 1); }}>{zh ? "重试恢复画面" : "Retry screen recovery"}</button>}
        {launchFailed && <><p className="chat-connect-hint">{zh ? "会话记录已保留；重试不会创建新的对话。" : "The session record is retained; retry does not create a new conversation."}</p><button type="button" className="btn chat-connect-retry" disabled={actionBusy} onClick={() => void retryDeferredLaunch()}>{resuming ? (zh ? "正在重试…" : "Retrying…") : (zh ? "重试启动" : "Retry startup")}</button></>}
        {launchReadIssue && <><p className="chat-connect-hint">{zh ? `无法检查启动状态：${launchReadIssue}` : `Unable to check startup status: ${launchReadIssue}`}</p><button type="button" className="btn" onClick={() => setLaunchAttempt(value => value + 1)}>{zh ? "重新检查" : "Check again"}</button></>}
      </div>
    </div>}
    {provider !== "codex" && session?.status === "starting" && <div className="term-starting" role="status" aria-live="polite"><div className="spinner" /><strong>{resuming ? (zh ? "正在恢复原对话…" : "Resuming conversation…") : (zh ? "正在启动终端…" : "Starting terminal…")}</strong></div>}
    </div><footer className="term-foot">{session?.worktreePath ? `${zh ? "工作目录" : "Working directory"} · ${displayPath(session.worktreePath)}` : (zh ? "返回工作台不会关闭会话" : "Returning to the workspace does not close the session")}</footer></div>;
}
