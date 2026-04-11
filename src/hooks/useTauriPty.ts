import { useEffect, useRef, useCallback } from 'react';
import { pty } from '../lib/tauri-bridge';
import type { Terminal } from '@xterm/xterm';

interface UseTauriPtyOptions {
  id: string;
  workingDir: string;
  terminal: Terminal | null;
  rows: number;
  cols: number;
}

export function useTauriPty({ id, workingDir, terminal, rows, cols }: UseTauriPtyOptions) {
  const unlistenOutputRef = useRef<(() => void) | null>(null);
  const unlistenExitRef = useRef<(() => void) | null>(null);

  const connect = useCallback(async () => {
    if (!terminal) return;

    // Set up output listener BEFORE creating PTY
    const unlistenOut = await pty.onOutput(({ id: sid, data }) => {
      if (sid === id) terminal.write(data);
    });
    const unlistenExit = await pty.onExit(({ id: sid }) => {
      if (sid === id) terminal.writeln('\r\n[Process exited]');
    });

    unlistenOutputRef.current = unlistenOut;
    unlistenExitRef.current = unlistenExit;

    try {
      await pty.create(id, workingDir, rows, cols);
    } catch (err) {
      terminal.writeln(`\r\nFailed to create terminal: ${err}`);
    }
  }, [id, workingDir, terminal, rows, cols]);

  useEffect(() => {
    connect();
    return () => {
      unlistenOutputRef.current?.();
      unlistenExitRef.current?.();
      pty.kill(id).catch(() => {});
    };
  }, [connect, id]);

  const sendInput = useCallback((data: string) => {
    pty.input(id, data).catch(console.error);
  }, [id]);

  const resize = useCallback((newRows: number, newCols: number) => {
    pty.resize(id, newRows, newCols).catch(console.error);
  }, [id]);

  return { sendInput, resize };
}
