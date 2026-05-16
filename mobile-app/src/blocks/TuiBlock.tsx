import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ITheme } from '@xterm/xterm';
import type { TuiBlock as TuiBlockModel } from '../ansi-classifier';
import { writeAppendOnlyTerminalData, type AppendRenderState } from './xtermAppendRenderer';

interface TuiBlockProps {
  block: TuiBlockModel;
  replayNonce: number;
  theme: ITheme;
  mode?: 'detail' | 'preview';
  // Optional PTY dimensions sourced from the latest terminal_snapshot. When supplied,
  // these win over the classifier's derived block.cols / block.lines so xterm gets a
  // canvas matched to the real PTY (avoids the "huge canvas with content jammed to
  // the right edge" and "every output chunk resizes the canvas" flicker symptoms).
  snapshotCols?: number;
  snapshotRows?: number;
}

export function TuiBlock({
  block,
  replayNonce,
  theme,
  mode = 'detail',
  snapshotCols,
  snapshotRows,
}: TuiBlockProps) {
  const isPreview = mode === 'preview';
  // Detail mode defaults to expanded so users see PTY output immediately; user can still toggle.
  // Preview mode is always rendered live regardless of state since there is no toggle UI.
  const [expanded, setExpanded] = useState(true);
  const effectiveExpanded = isPreview ? true : expanded;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const renderStateRef = useRef<AppendRenderState>({ renderedData: '', initialized: false });
  const replayNonceRef = useRef(replayNonce);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  const disposeTerminal = () => {
    terminalRef.current?.dispose();
    terminalRef.current = null;
    renderStateRef.current.renderedData = '';
    renderStateRef.current.initialized = false;
    lastSizeRef.current = null;
  };

  useEffect(() => {
    return () => disposeTerminal();
  }, []);

  useEffect(() => {
    if (!effectiveExpanded) {
      disposeTerminal();
    }
  }, [effectiveExpanded]);

  useEffect(() => {
    if (!effectiveExpanded || !hostRef.current) return;
    const host = hostRef.current;
    const cols =
      snapshotCols && snapshotCols >= 1 ? snapshotCols : Math.max(80, block.cols);
    const rows =
      snapshotRows && snapshotRows >= 1
        ? snapshotRows
        : Math.min(40, Math.max(4, block.lines + 1));

    let createdTerminal = false;
    if (!terminalRef.current) {
      host.textContent = '';
      replayNonceRef.current = replayNonce;
      const fitAddon = new FitAddon();
      terminalRef.current = new Terminal({
        cols,
        rows,
        convertEol: true,
        disableStdin: true,
        cursorBlink: false,
        fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 11,
        lineHeight: 1.2,
        scrollback: 200,
        theme,
      });
      terminalRef.current.loadAddon(fitAddon);
      terminalRef.current.open(host);
      lastSizeRef.current = { cols, rows };
      createdTerminal = true;
    } else {
      if (replayNonceRef.current !== replayNonce) {
        terminalRef.current.reset();
        renderStateRef.current.renderedData = '';
        renderStateRef.current.initialized = false;
        replayNonceRef.current = replayNonce;
      }
      terminalRef.current.options.theme = { ...theme };
      // Avoid calling resize on every render: each call re-flows the buffer and causes
      // visible flicker on streaming output. Only resize when dimensions actually change.
      const last = lastSizeRef.current;
      if (!last || last.cols !== cols || last.rows !== rows) {
        terminalRef.current.resize(cols, rows);
        lastSizeRef.current = { cols, rows };
      }
    }

    writeAppendOnlyTerminalData(terminalRef.current, renderStateRef.current, block.data);

    // After the first open(), force a renderer refresh on the next animation frame so
    // that initial paint does not get skipped when the host layout was still settling
    // (e.g. detail screen mounted inside a flex column whose flex basis resolves async).
    if (createdTerminal) {
      const terminal = terminalRef.current;
      const refreshNow = () => {
        if (terminalRef.current !== terminal) return;
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
      };
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(refreshNow);
      } else {
        refreshNow();
      }
    }
  }, [
    block.cols,
    block.data,
    block.lines,
    effectiveExpanded,
    replayNonce,
    theme,
    snapshotCols,
    snapshotRows,
  ]);

  const sectionClassName = isPreview ? 'tui-block tui-block-preview' : 'tui-block';

  if (isPreview) {
    return (
      <section className={sectionClassName}>
        <div className="tui-scroll-shell">
          <div className="tui-xterm-host" ref={hostRef} />
        </div>
      </section>
    );
  }

  return (
    <section className={sectionClassName}>
      <button className="tui-summary" type="button" onClick={() => setExpanded((value) => !value)}>
        <span className="tui-summary-mark">TUI</span>
        <span className="tui-summary-title">
          {block.lines} lines · {block.cols} cols
        </span>
        <span className="tui-summary-reason">{block.reason.replace('-', ' ')}</span>
      </button>
      {expanded && (
        <div className="tui-scroll-shell">
          <div className="tui-xterm-host" ref={hostRef} />
        </div>
      )}
    </section>
  );
}
