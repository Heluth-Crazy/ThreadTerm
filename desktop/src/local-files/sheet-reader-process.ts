/**
 * The Electron `utilityProcess` behind the main-process sheet host (`design.md` §3.4).
 *
 * A utility process is ThreadTerm.exe: with Local file access = main, the only extra process
 * that ever sees the workbook is this reader, and it opens no files — the main process feeds
 * it the bytes inside the same ThreadTerm.exe installation (R22). Spike C/V (validation.md S5)
 * chose it over a `worker_threads` Worker: the workbook's memory leaves with the process and
 * the main process returned to +6.6 MiB, where a Worker kept +19 MiB and its own 1.5 GiB peak
 * inside the main process.
 */
import { utilityProcess } from 'electron';
import type { SheetReaderFactory } from './sheet-host.js';
import type { ReaderMessage } from './sheet-reader-core.js';

export function startSheetReaderProcess({ wasm }: { wasm: string }): ReturnType<SheetReaderFactory> {
  const child = utilityProcess.fork(`${__dirname}/sheet-reader.cjs`, [], {
    serviceName: 'ThreadTerm sheet reader',
    stdio: 'inherit',
    // The reader reads the module itself; it never learns the workbook's path.
    env: { ...process.env, THREADTERM_SHEET_WASM: wasm },
  });
  if (!child) throw new Error('sheet_worker_failed');
  const messageListeners = new Set<(message: ReaderMessage) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  child.on('message', (message: unknown) => { for (const listener of messageListeners) listener(message as ReaderMessage); });
  child.on('exit', (code: number) => { for (const listener of exitListeners) listener(code); });
  return {
    post: message => child.postMessage(message),
    onMessage: listener => { messageListeners.add(listener); },
    onExit: listener => { exitListeners.add(listener); },
    kill: () => { child.kill(); },
  };
}
