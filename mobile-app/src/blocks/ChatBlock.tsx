import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import type { ChatBlock as ChatBlockModel } from '../ansi-classifier';
import { writeAppendOnlyTerminalData, type AppendRenderState } from './xtermAppendRenderer';

interface ChatBlockProps {
  block: ChatBlockModel;
  replayNonce: number;
  theme: ITheme;
}

export function ChatBlock({ block, replayNonce, theme }: ChatBlockProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const renderStateRef = useRef<AppendRenderState>({ renderedData: '', initialized: false });
  const replayNonceRef = useRef(replayNonce);

  useEffect(() => {
    return () => {
      terminalRef.current?.dispose();
      terminalRef.current = null;
      renderStateRef.current.renderedData = '';
      renderStateRef.current.initialized = false;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const cols = measureCols(host);
    const rows = estimateRows(block.data, cols);
    if (!terminalRef.current) {
      host.textContent = '';
      replayNonceRef.current = replayNonce;
      terminalRef.current = new Terminal({
        cols,
        rows,
        convertEol: true,
        disableStdin: true,
        cursorBlink: false,
        cursorStyle: 'bar',
        fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.35,
        scrollback: 0,
        theme,
      });
      terminalRef.current.open(host);
    } else {
      if (replayNonceRef.current !== replayNonce) {
        terminalRef.current.reset();
        renderStateRef.current.renderedData = '';
        renderStateRef.current.initialized = false;
        replayNonceRef.current = replayNonce;
      }
      terminalRef.current.options.theme = { ...theme };
      terminalRef.current.resize(cols, rows);
    }

    writeAppendOnlyTerminalData(terminalRef.current, renderStateRef.current, block.data);
  }, [block.data, replayNonce, theme]);

  return <div className="terminal-chat-block" ref={hostRef} />;
}

const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()][A-Za-z0-9])/g;

function estimateRows(data: string, cols: number): number {
  const visible = data.replace(ANSI_PATTERN, '').replace(/\r/g, '');
  const lineRows = visible.split('\n').reduce((total, line) => {
    const width = Math.max(1, Array.from(line).length);
    return total + Math.max(1, Math.ceil(width / cols));
  }, 0);
  return Math.min(1000, Math.max(2, lineRows + 1));
}

function measureCols(host: HTMLElement): number {
  const width = host.clientWidth || host.getBoundingClientRect().width || 420;
  return Math.min(120, Math.max(24, Math.floor(width / 7)));
}
