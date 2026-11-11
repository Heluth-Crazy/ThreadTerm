/**
 * The reader side of the WebAssembly sheet host (`design.md` §3.4): one workbook per
 * process, bytes fed in, JSON windows out. This module holds everything except the process
 * plumbing, so the parity script can run the same code the shipped reader runs.
 *
 * It mirrors `runtime/src/sheet_worker.rs`: the first `rows` for a sheet starts its load and
 * answers `loading`, a failed load keeps its code for that sheet, and one load runs at a
 * time. WebAssembly has no threads, so the load runs synchronously on this process's event
 * loop; the main host answers `rows` with `state:'loading'` itself while that happens
 * (`design.md` §3.1: no request waits for a load).
 */
import type { SheetEngine } from './sheet-wasm.js';

/** `SheetRows` of `protocol/index.ts`, as the core's JSON. */
export type ReaderSheetRows = {
  state: 'loading' | 'ready';
  progress?: number;
  totalRows: number;
  totalColumns: number;
  start: number;
  columnStart: number;
  rows: unknown[];
  merges?: [number, number, number, number][];
  clipped?: boolean;
  truncated?: boolean;
};

export type ReaderSheetInfo = { name: string; visible: boolean };

/** main → reader. */
export type ReaderCommand =
  | { t: 'feed'; chunk: Uint8Array }
  | { t: 'open'; format: string }
  | { t: 'rows'; id: number; request: { sheet: number; start: number; count: number; columnStart: number; columnCount: number } }
  | { t: 'memory' };

/** reader → main. One reply per command that asks for one, plus state changes. */
export type ReaderMessage =
  | { t: 'ready' }
  | { t: 'fed'; bytes: number }
  | { t: 'opened'; sheets: ReaderSheetInfo[] }
  | { t: 'rows'; id: number; reply: { ok: true; result: ReaderSheetRows } | { ok: false; code: string } }
  | { t: 'load-started'; sheet: number }
  | { t: 'load-done'; sheet: number }
  | { t: 'load-failed'; sheet: number; code: string }
  | { t: 'memory'; rss: number; peak: number; linear: number }
  | { t: 'failed'; code: string };

type Status = 'loading' | 'ready' | { failed: string };

export type SheetReaderSession = {
  feed(chunk: Uint8Array): void;
  open(format: string): void;
  rows(id: number, request: { sheet: number; start: number; count: number; columnStart: number; columnCount: number }): void;
  memory(): void;
  loadedSheets(): number[];
};

/** The core's answer to one JSON request. */
type CoreReply = { ok: true; result: unknown } | { ok: false; error?: string; message?: string };

const codeOf = (reply: CoreReply): string =>
  reply.ok ? 'invalid_request' : typeof reply.error === 'string' && reply.error ? reply.error : 'sheet_worker_failed';

const loadingReply = (start: number, columnStart: number): ReaderSheetRows => ({
  state: 'loading', totalRows: 0, totalColumns: 0, start, columnStart, rows: [],
});

/**
 * @param post one message out; called synchronously for replies.
 * @param schedule how the load is deferred so the `loading` reply leaves first (the process
 *   event loop in production, a direct callback in tests).
 * @param memory the reader's own footprint; `app.getAppMetrics()` under-reports a utility
 *   process on Windows (`validation.md`), so the reader measures itself.
 */
export function createReaderSession(engine: SheetEngine, post: (message: ReaderMessage) => void,
  schedule: (run: () => void) => void, memory: () => { rss: number; peak: number }): SheetReaderSession {
  const status = new Map<number, Status>();
  let opened = false;
  let loadingSheet: number | undefined;

  const ask = (request: Record<string, unknown>): CoreReply => {
    let text: string;
    try { text = engine.request(JSON.stringify(request)); }
    catch { return { ok: false, error: 'sheet_out_of_memory' }; }
    try { return JSON.parse(text) as CoreReply; }
    catch { return { ok: false, error: 'sheet_worker_failed' }; }
  };

  function startLoad(sheet: number) {
    loadingSheet = sheet;
    post({ t: 'load-started', sheet });
    schedule(() => {
      const reply = ask({ method: 'load', sheet });
      loadingSheet = undefined;
      if (reply.ok) {
        status.set(sheet, 'ready');
        post({ t: 'load-done', sheet });
      } else {
        const code = codeOf(reply);
        status.set(sheet, { failed: code });
        post({ t: 'load-failed', sheet, code });
      }
      session.memory();
    });
  }

  const session: SheetReaderSession = {
    feed(chunk) {
      try {
        post({ t: 'fed', bytes: engine.feed(chunk) });
      } catch {
        // The module traps when an allocation passes the 2 GiB memory cap (S2).
        post({ t: 'failed', code: 'sheet_out_of_memory' });
      }
    },

    open(format) {
      const reply = ask({ method: 'open', format });
      if (!reply.ok) {
        post({ t: 'failed', code: codeOf(reply) });
        return;
      }
      const result = reply.result as { sheets?: ReaderSheetInfo[] };
      opened = true;
      status.clear();
      loadingSheet = undefined;
      post({ t: 'opened', sheets: (result.sheets ?? []).map(sheet => ({ name: sheet.name, visible: sheet.visible })) });
    },

    rows(id, request) {
      if (!opened) {
        post({ t: 'rows', id, reply: { ok: false, code: 'sheet_not_found' } });
        return;
      }
      // One load at a time: while a sheet loads, every window answers `loading` (as the
      // native helper does). The main host does not send these, but the sequence must
      // still be right for the parity run.
      if (loadingSheet !== undefined) {
        post({ t: 'rows', id, reply: { ok: true, result: loadingReply(request.start, request.columnStart) } });
        return;
      }
      const state = status.get(request.sheet);
      if (state === 'ready') {
        const reply = ask({ method: 'rows', ...request });
        post({ t: 'rows', id, reply: reply.ok ? { ok: true, result: reply.result as ReaderSheetRows } : { ok: false, code: codeOf(reply) } });
        return;
      }
      if (state && typeof state === 'object') {
        post({ t: 'rows', id, reply: { ok: false, code: state.failed } });
        return;
      }
      if (state !== 'loading') {
        status.set(request.sheet, 'loading');
        post({ t: 'rows', id, reply: { ok: true, result: loadingReply(request.start, request.columnStart) } });
        startLoad(request.sheet);
        return;
      }
      post({ t: 'rows', id, reply: { ok: true, result: loadingReply(request.start, request.columnStart) } });
    },

    memory() {
      const usage = memory();
      post({ t: 'memory', rss: usage.rss, peak: usage.peak, linear: engine.linearMemoryBytes() });
    },

    loadedSheets() {
      return [...status.entries()].filter(([, value]) => value === 'ready').map(([sheet]) => sheet);
    },
  };
  return session;
}
