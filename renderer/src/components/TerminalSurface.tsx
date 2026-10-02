import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { WebLinksAddon } from '@xterm/addon-web-links';
import "@xterm/xterm/css/xterm.css";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { openExternal, operationId, outputSubscription, request } from "../bridge";
import { acquireControl } from '../controlLease';
import { registerTerminalInputTarget } from '../terminalInputTargets';
import { useTranslation } from '../i18n';
import { terminalTheme } from '../terminalTheme';
import './terminal-surface.css';
import {BlockInspector} from './BlockInspector';
import { AgentIcon, Icon } from './PrototypeIcon';
import { AgentLoadingMark } from './AgentLoadingMark';
import { SessionSurfaceContext, SurfaceActions } from './SessionSurfaceContext';
import { parseFileReference } from '../fileReferences';
import { createFileLinkValidator, createTerminalFileLinkHitArea, createTerminalFileLinkInteraction, fileLinkStatusOf, provideTerminalFileLinks } from './terminalFileLinks';
import type { ProviderId, Session, TerminalLaunchState } from "@threadterm/protocol";
import {
  aiCompletionHintsEnabled,
  appendTerminalOutputTail,
  hasTentativeAiCompletionPrompt,
} from "./terminalCompletionHint";

type Props = { sessionId: string; provider: ProviderId; theme: "light" | "dark"; terminalCompatibility: unknown; session?: Session; onConfigure?: () => void; onCloseView?: () => void; onChanged?: () => void; onOpenSession?: (id: string) => void; resumeCapture?: "preassigned" | "none" };
// A failed screen recovery is shown once, in the overlay: a plain-language reason for the
// user and the technical detail behind a disclosure (never as a second .surface-error line).
type ReplayFailure = { reason: "stalled" | "gap" | "error"; detail: string };
const isLive = (session?: Session) => Boolean(session && !session.readOnly && ["starting", "running", "idle", "waiting"].includes(session.status));
// Raw PTY logs can contain hours of animation, not merely conversation text.
// Bound each read, not the history prefix needed by the terminal parser.
const REPLAY_PAGE_BYTES = 1024 * 1024;
const REPLAY_STALL_MS = 15_000;
const hasVisibleTerminalFrame = (terminal: Terminal) => {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true).trim() ?? "").some(Boolean);
};

// Presentation may hide the xterm cursor while a session is read-only. Keep
// the provider's last DECTCEM choice separately so returning to a live PTY
// does not reveal a second cursor over a provider-painted input caret.
const nativeCursorVisibility = () => {
  let state: 'text' | 'escape' | 'csi' | 'string' | 'string-escape' = 'text';
  let privateMode = false;
  let validCsi = false;
  let intermediate = false;
  let parameterValue = 0;
  let parameterHasDigits = false;
  let parameterCount = 0;
  let hasCursorParameter = false;
  let parametersStarted = false;
  let visible: boolean | undefined;
  const escapeByte = (byte: number) => {
    if (byte === 0x5b) { state = 'csi'; privateMode = false; validCsi = true; intermediate = false; parameterValue = 0; parameterHasDigits = false; parameterCount = 0; hasCursorParameter = false; parametersStarted = false; }
    else if (byte === 0x5d || byte === 0x50 || byte === 0x5e || byte === 0x5f) state = 'string';
    else state = byte === 0x1b ? 'escape' : 'text';
  };
  return {
    observe(bytes: Uint8Array) {
      for (const byte of bytes) {
        if (state === 'string') {
          if (byte === 0x1b) state = 'string-escape';
          else if (byte === 0x07 || byte === 0x18 || byte === 0x1a) state = 'text';
        } else if (state === 'string-escape' || state === 'escape') {
          escapeByte(byte);
        } else if (state === 'csi') {
          if (byte === 0x1b) state = 'escape';
          else if (byte === 0x18 || byte === 0x1a) state = 'text'; // CAN/SUB cancel CSI.
          else if (byte >= 0x40 && byte <= 0x7e) {
            if (validCsi && privateMode && !intermediate && (hasCursorParameter || (parameterCount < 32 && parameterHasDigits && parameterValue === 25)) && (byte === 0x68 || byte === 0x6c)) visible = byte === 0x68;
            state = 'text';
          } else if (byte >= 0x20 && byte <= 0x2f) intermediate = true;
          else if (byte === 0x3f && !privateMode && !parametersStarted && !intermediate) privateMode = true;
          else if (byte >= 0x30 && byte <= 0x39 && !intermediate) {
            parametersStarted = true;
            parameterHasDigits = true;
            parameterValue = Math.min(26, parameterValue * 10 + byte - 0x30);
          } else if (byte === 0x3b && !intermediate) {
            hasCursorParameter ||= parameterCount < 32 && parameterHasDigits && parameterValue === 25;
            parameterValue = 0;
            parameterHasDigits = false;
            parameterCount += 1;
            parametersStarted = true;
          }
          else if (byte < 0x20 || byte === 0x7f) { /* C0/DEL executes or is ignored without cancelling CSI. */ }
          else validCsi = false;
        } else if (byte === 0x1b) state = 'escape';
      }
    },
    isVisible: () => visible !== false,
  };
};

export function TerminalSurface({ sessionId, provider, theme, terminalCompatibility, session, onConfigure, onCloseView, onChanged, onOpenSession, resumeCapture }: Props) {
  const {locale} = useTranslation();
  const surface = useContext(SessionSurfaceContext);
  const openFileRef = useRef(surface?.openFile);
  openFileRef.current = surface?.openFile;
  const zh = locale === 'zh-CN';
  const host = useRef<HTMLDivElement>(null); const terminalRef = useRef<Terminal | undefined>(undefined);
  const controlRef = useRef<((enabled: boolean) => void) | undefined>(undefined);
  const [issue, setIssue] = useState<string>();
  const [unread, setUnread] = useState(0);
  const [selectedLink, setSelectedLink] = useState<string>();
  const [inspected, setInspected] = useState<string>();
  const [hasSelection,setHasSelection] = useState(false);
  const [selectionFile, setSelectionFile] = useState<import('@threadterm/protocol').FileReference>();
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
  const [replayFailure, setReplayFailure] = useState<ReplayFailure>();
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
  // Layout effect: the ended footer appears in the same commit and shrinks the host; the
  // ResizeObserver fires before passive effects, so a stale ref would refit (reflow) the frame.
  useLayoutEffect(() => { fixedSizeRef.current = fixedSize; }, [fixedSize]);
  const canControlRef = useRef(canControl);
  const nativeCursorRef = useRef<ReturnType<typeof nativeCursorVisibility> | undefined>(undefined);
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
    let replayTotal: number | undefined;
    let replayLastProgress = Date.now();
    const failReplay = (reason: ReplayFailure["reason"], detail: string) => {
      if (disposed || replayComplete || replayAborted) return;
      replayAborted = true;
      window.clearInterval(replayTimer);
      for (const settle of pendingWrites) settle();
      unsubscribeOutput?.(); unsubscribeOutput = undefined;
      setReplayFailure({ reason, detail });
      setReplay({ key: replayKey, phase: "failed" });
    };
    const pendingWrites = new Set<() => void>();
    let controlGeneration = 0;
    let lastResize: string | undefined;
    let resizeRetried: string | undefined;
    const resizeFailureNote = "Terminal resize was rejected; the provider may keep using the previous size until the next successful resize.";
    const terminal = new Terminal({ ...(fixedSize ? { cols: fixedSize.cols, rows: fixedSize.rows } : {}), cursorBlink: true, fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: 13, lineHeight: 1.35, minimumContrastRatio: 4.5, scrollback: 10000, scrollOnEraseInDisplay: false, windowsPty: window.threadterm.windowsPty, theme: terminalTheme(theme) });
    terminalRef.current = terminal;
    const nativeCursor = nativeCursorVisibility();
    nativeCursorRef.current = nativeCursor;
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
    const fileLinkInteraction = createTerminalFileLinkInteraction(element);
    // Link only what the session's runtime can find, so `3.14` or half of a wrapped path is not offered.
    const fileLinkValidator = createFileLinkValidator(path => request('filesystem.resolve', { sessionId, path }).then(() => 'exists' as const, fileLinkStatusOf));
    const fileLinkDisposable = terminal.registerLinkProvider({ provideLinks: (line, callback) => {
      if (!openFileRef.current) { callback(undefined); return; }
      void provideTerminalFileLinks(terminal, line, reference => openFileRef.current?.(reference), fileLinkInteraction, fileLinkValidator).then(callback, () => callback(undefined));
    } });
    const fileLinkHitArea = openFileRef.current ? createTerminalFileLinkHitArea(terminal, reference => openFileRef.current?.(reference), fileLinkValidator) : undefined;
    const selectionDisposable=terminal.onSelectionChange(()=>{
      setHasSelection(terminal.hasSelection());
      setSelectionFile(parseFileReference(terminal.getSelection().trim()));
    });
    const scrollDisposable = terminal.onScroll(() => {
      if (terminal.buffer.active.viewportY >= terminal.buffer.active.baseY) setUnread(0);
    });
    terminal.options.disableStdin = true; setIssue(undefined); setReplayFailure(undefined); setCompletionHint(false);
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
        const seconds = REPLAY_STALL_MS / 1000;
        failReplay("stalled", replayTotal === undefined
          ? (zh ? `terminal.read（历史边界）在 ${seconds} 秒内没有响应。` : `terminal.read (history boundary) did not answer within ${seconds} s.`)
          : (zh ? `回放停在第 ${replayCursor} / ${replayTotal} 字节（${seconds} 秒无进展）。` : `Replay stopped advancing at byte ${replayCursor} of ${replayTotal} (no progress for ${seconds} s).`));
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
        replayTotal = replayEnd;
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
              failReplay("gap", zh ? `保留的输出有缺口，从第 ${chunk.cursor} 字节才继续（已回放 ${replayCursor} / ${replayEnd}）。` : `Retained output has a gap and resumes at byte ${chunk.cursor} (replayed ${replayCursor} of ${replayEnd}).`);
              return;
            }
            setIssue("Some older terminal output is no longer available. Live output continues.");
          }
          if (chunk.data.byteLength) {
            nativeCursor.observe(chunk.data);
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
        const message = error instanceof Error ? error.message : String(error ?? "Terminal could not connect.");
        failReplay(message.includes("terminal_history_gap") ? "gap" : "error", message);
      }
    })();
    return () => { disposed = true; resumeFrameProbeRef.current?.dispose(); resumeFrameProbeRef.current = undefined; window.clearInterval(replayTimer); for (const settle of pendingWrites) settle(); setControl(false); unregisterInput(); observer.disconnect(); dataDisposable.dispose(); scrollDisposable.dispose(); selectionDisposable.dispose(); fileLinkDisposable.dispose(); fileLinkHitArea?.dispose(); fileLinkInteraction.dispose(); unsubscribeOutput?.(); terminal.dispose(); if (terminalRef.current === terminal) terminalRef.current = undefined; if (nativeCursorRef.current === nativeCursor) nativeCursorRef.current = undefined; if (controlRef.current === setControl) controlRef.current = undefined; };
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
    // A resumed session returns to the provider's own cursor mode, not an
    // unconditional visible host cursor (Claude paints its input caret).
    if (canControl) { terminal.write(nativeCursorRef.current?.isVisible() === false ? "\x1b[?25l" : "\x1b[?25h"); return; }
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
      ? (zh ? "该提供方不支持恢复终端会话。" : "This provider can't resume terminal sessions.")
      : (zh ? "无法恢复此对话：没有记录原生会话标识。" : "This conversation can't be resumed: no native session ID was recorded."))
    : undefined;
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
  const replayFailureText = replayFailure?.reason === "stalled"
    ? (zh ? "加载历史输出时没有响应。" : "Loading the saved output stopped responding.")
    : replayFailure?.reason === "gap"
      ? (zh ? "部分历史输出已缺失，无法完整重建画面。" : "Part of the saved output is missing, so the screen can't be rebuilt exactly.")
      : (zh ? "无法加载历史输出。" : "The saved output couldn't be loaded.");
  const retryReplay = () => { setReplayFailure(undefined); setReplay({ key: replayKey, phase: "catching" }); setReplayAttempt(value => value + 1); };
  // One footer states why the terminal takes no input and offers the next step. It sits where
  // input would go; the overlay owns failed/pending launches, so the footer waits for them.
  const endedBanner = session && (session.readOnly || ended) && !launchFailed && !(launchPending && !showTerminal)
    ? {
      title: session.readOnly ? (zh ? "只读记录" : "Read-only record") : (zh ? "会话已结束" : "Session ended"),
      detail: session.readOnly ? (zh ? "这是保存的终端输出，无法继续输入。" : "Showing saved terminal output; it can't take input.")
        : resumeBlocked ?? (zh ? "正在显示保存的输出。" : "Showing saved output."),
      action: session.readOnly ? undefined
        : agentProvider && !resumeBlocked
          ? <button type="button" className="btn" disabled={actionBusy} title={zh ? "通过提供方原生机制恢复原对话" : "Continue the original conversation"} onClick={() => void resume()}>{resuming ? (zh ? "恢复中…" : "Resuming…") : (zh ? "继续会话" : "Resume")}</button>
          : agentProvider
            ? <button type="button" className="btn" disabled={actionBusy} title={zh ? "沿用保存的配置开始全新对话" : "Start a fresh conversation with the saved configuration"} onClick={() => void rerun()}>{zh ? "新建同配置会话" : "New with same config"}</button>
            : <button type="button" className="btn" disabled={actionBusy} onClick={() => void rerun()}>{zh ? "重新执行" : "Run again"}</button>,
    }
    : undefined;
  const hasEndedBanner = Boolean(endedBanner);
  useLayoutEffect(() => {
    // A session that ends while shown keeps its xterm at the live size (fixed geometry); the
    // footer takes its height from the host, so keep the last rows (exit output) in view.
    const element = host.current;
    if (hasEndedBanner && sawControl.value && element) element.scrollTop = element.scrollHeight;
  }, [hasEndedBanner, sawControl.value]);
  return <div className="terminal-wrap term">
    <div className="terminal-local-action-row">
    <SurfaceActions slot="primary">
      {launchPending && !replaying && !showTerminal && <button type="button" className="btn" onClick={() => setShowTerminal(true)}>{zh ? "显示终端" : "Show terminal"}</button>}
    </SurfaceActions>
    <SurfaceActions slot="menu">
      <button className="menu-item" disabled={!session || actionBusy} aria-label={session?.followed ? (zh ? "取消关注" : "Unfollow") : (zh ? "关注" : "Follow")} aria-pressed={Boolean(session?.followed)} onClick={() => void toggleFollow()}>{session?.followed ? (zh ? "取消关注" : "Unfollow") : (zh ? "关注" : "Follow")}</button>
      {isLive(session) && <button className="menu-item danger term-stop" disabled={actionBusy} onClick={() => void stop()}>{zh ? "结束会话" : "End session"}</button>}
      {session && !session.readOnly && ended && agentProvider && <button className="menu-item" disabled={actionBusy} title={zh ? "沿用保存的配置开始全新对话" : "Start a fresh conversation with the saved configuration"} onClick={() => void rerun()}>{zh ? "新建同配置会话" : "New with same config"}</button>}
      {onConfigure && <button className="menu-item" onClick={onConfigure}>{zh ? "配置" : "Configure"}</button>}
      {onCloseView && <button className="menu-item" onClick={onCloseView}>{zh ? "关闭视图" : "Close view"}</button>}
    </SurfaceActions>
    </div>
    {unknownGeometry && <p className="term-legacy-note" role="status">{zh ? "该历史会话未记录终端尺寸，部分全屏界面可能错位。重新运行可生成可稳定回放的新记录。" : "This historical session has no recorded terminal size; full-screen interfaces may be misaligned. Rerun it to create a new record that replays reliably."}</p>}
    <div className="term-content"><div className={`terminal-host term-output${fixedSize ? " fixed-geometry" : ""}`} ref={host} aria-label={zh ? '实时终端输出' : 'Live terminal output'} />
    {(hasSelection || (selectionFile && openFileRef.current)) && <div className="terminal-selection-actions">
      {selectionFile && openFileRef.current && <button type="button" className="terminal-open-selection" onClick={() => openFileRef.current?.(selectionFile)} title={selectionFile.path}>{zh ? '打开所选文件' : 'Open selected file'}</button>}
      {hasSelection&&<button type="button" className="terminal-inspect-selection" onClick={()=>setInspected(terminalRef.current?.getSelection()??'')}>{zh?'检查选区':'Inspect selection'}</button>}
    </div>}
    {inspected!==undefined&&<BlockInspector sessionId={sessionId} text={inspected} onClose={()=>setInspected(undefined)}/>}
    {unread > 0 && <button className="terminal-new-output" onClick={() => {terminalRef.current?.scrollToBottom();setUnread(0);}}>{zh ? `${unread} 批新输出 · 回到底部` : `${unread} new ${unread === 1 ? 'update' : 'updates'} · Back to bottom`}</button>}
    {completionHints && completionHint && <p className="terminal-completion-hint" role="status">{zh ? "可能已准备好输入" : "Possibly ready for input"}</p>}
    {selectedLink && <div className="terminal-link-actions"><span title={selectedLink}>{selectedLink}</span><button onClick={() => void openExternal(selectedLink).catch(error => setIssue(String(error)))}>{zh ? '在浏览器中打开' : 'Open in browser'}</button><button onClick={() => void navigator.clipboard.writeText(selectedLink).catch(error => setIssue(String(error)))}>{zh ? '复制链接' : 'Copy link'}</button><button onClick={() => setSelectedLink(undefined)}>{zh ? '关闭' : 'Close'}</button></div>}
    {issue && !replayFailed && <div className="surface-error" role="alert">{issue}</div>}
    {(replaying || replayFailed || launchFailed || (launchPending && !showTerminal)) && <div className={`term-loading-overlay${replaying ? " term-replaying" : ""}${replayFailed || launchFailed ? " is-failed" : ""}`} role={replayFailed || launchFailed ? "alert" : "status"} aria-live="polite" aria-label={replayFailed ? (zh ? "无法显示终端画面" : "Couldn't show the terminal screen") : loadingStatus}>
      <div className="chat-connect-center">
        <AgentLoadingMark provider={provider} active={!replayFailed && !launchFailed} />
        {launchFailed && !replayFailed && <p className="chat-connect-status">{loadingStatus}</p>}
        {replayFailed && <>
          <p className="chat-connect-status">{zh ? "无法显示终端画面" : "Couldn't show the terminal screen"}</p>
          <p className="chat-connect-hint">{replayFailureText} {zh ? "会话记录没有改动。" : "The session record is unchanged."}</p>
          <button type="button" className="btn" onClick={retryReplay}>{zh ? "重试" : "Retry"}</button>
          {replayFailure && <details className="term-failure-details">
            <summary>{zh ? "详细信息" : "Details"}<Icon name="chevD" /></summary>
            <p>{replayFailure.detail}</p>
          </details>}
        </>}
        {launchFailed && <><p className="chat-connect-hint">{zh ? "会话记录已保留；重试不会创建新的对话。" : "The session record is retained; retry does not create a new conversation."}</p><button type="button" className="btn chat-connect-retry" disabled={actionBusy} onClick={() => void retryDeferredLaunch()}>{resuming ? (zh ? "正在重试…" : "Retrying…") : (zh ? "重试启动" : "Retry startup")}</button></>}
        {launchReadIssue && <><p className="chat-connect-hint">{zh ? `无法检查启动状态：${launchReadIssue}` : `Unable to check startup status: ${launchReadIssue}`}</p><button type="button" className="btn" onClick={() => setLaunchAttempt(value => value + 1)}>{zh ? "重新检查" : "Check again"}</button></>}
      </div>
    </div>}
    {provider !== "codex" && session?.status === "starting" && <div className="term-starting" role="status" aria-live="polite"><AgentLoadingMark provider={provider} active /><strong className="sr-only">{resuming ? (zh ? "正在恢复原对话…" : "Resuming conversation…") : (zh ? "正在启动终端…" : "Starting terminal…")}</strong></div>}
    </div>
    {endedBanner && <div className={`term-ended-banner${session?.readOnly ? " is-readonly" : ""}`} role="note">
      <span className="term-ended-dot" aria-hidden="true" />
      <p><strong>{endedBanner.title}</strong><span>{endedBanner.detail}</span></p>
      {endedBanner.action}
    </div>}
    </div>;
}
