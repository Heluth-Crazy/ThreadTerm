import type { RequestResult } from '@threadterm/protocol';
import type { SheetRange } from './sheetGrid';

/** One bounded window of a sheet, modeled on `largeFileWindow.ts`: generation-fenced replies,
 * no history beyond the resident window, polling while the sheet loads, `file_changed` cleared
 * until an explicit Reload, `sheet_not_found` reopened once (`design.md` §3.1, §3.6). */

/** Polling while `state:'loading'`: 300 ms, doubling to 1 s and staying there. */
export const SHEET_POLL_MS = 300;
export const SHEET_POLL_MAX_MS = 1000;
/** R15: a larger selection says so instead of being fetched. */
export const SHEET_COPY_MAX_CELLS = 10_000;
/** At most 500 rows and 200 columns per request (`protocol/index.ts`); stay under both. */
export const SHEET_REQUEST_ROWS = 300;
export const SHEET_REQUEST_COLUMNS = 200;

export type SheetWorkbook = RequestResult<'filesystem.sheet.open'>;
export type SheetRowsReply = RequestResult<'filesystem.sheet.rows'>;
export type SheetCell = SheetRowsReply['rows'][number][number];

/** The resident window: absolute 0-based coordinates plus the cells, padded so
 * `rows[row - start][column - columnStart]` is always in range. */
export type SheetWindow = SheetRange & { rows: SheetCell[][]; clipped: boolean };

export type SheetViewerState = {
  workbook?: SheetWorkbook;
  sheet: number;
  window?: SheetWindow;
  totalRows: number;
  totalColumns: number;
  /** The sheet is loading on the host; `progress` is 0..1 when the core knows it. */
  loading: boolean;
  progress?: number;
  /** A request is in flight. */
  busy: boolean;
  /** `file_changed`: the window was cleared and nothing is read until Reload. */
  changed: boolean;
  error?: unknown;
};

export type SheetRowsRequest = {
  handle: string; sheet: number; start: number; count: number; columnStart: number; columnCount: number;
};

/** The two read methods (`filesystem.sheet.*` or `filesystem.external.sheet.*`) behind one
 * interface, so the loader is the same for a project file and a registered external file. */
export type SheetTransport = {
  open: () => Promise<SheetWorkbook>;
  rows: (request: SheetRowsRequest) => Promise<SheetRowsReply>;
  close: (handle: string) => Promise<unknown>;
};

export const sheetErrorCode = (error: unknown): string | undefined => {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  const text = error instanceof Error ? error.message : String(error);
  return ['sheet_not_found', 'file_changed', 'sheet_out_of_memory', 'sheet_too_complex', 'sheet_worker_failed',
    'file_too_large', 'unsupported_document', 'document_protected', 'external_file_unknown', 'file_unavailable']
    .find(code => new RegExp(`\\b${code}\\b`).test(text));
};

const initial: SheetViewerState = { sheet: 0, totalRows: 0, totalColumns: 0, loading: false, busy: false, changed: false };

const padRow = (row: readonly SheetCell[], columns: number): SheetCell[] => {
  const cells = [...row];
  while (cells.length < columns) cells.push(null);
  return cells.slice(0, columns);
};

/** Fetches one rectangle, asking again where a reply stopped when the 1 MiB cap trimmed it.
 * `alive` fences a stale read after a newer one started, so it stops asking instead of racing. */
async function readRectangle(transport: SheetTransport, handle: string, sheet: number, range: SheetRange, alive: () => boolean = () => true) {
  const columnCount = Math.min(range.columnCount, SHEET_REQUEST_COLUMNS);
  const rows: SheetCell[][] = [];
  let start = range.start;
  let totalRows = 0, totalColumns = 0, clipped = false;
  for (;;) {
    if (!alive()) return undefined;
    const count = Math.min(SHEET_REQUEST_ROWS, range.count - rows.length);
    if (count <= 0) break;
    const reply = await transport.rows({ handle, sheet, start, count, columnStart: range.columnStart, columnCount });
    if (!alive()) return undefined;
    if (reply.state === 'loading') return { loading: true as const, progress: reply.progress, totalRows: reply.totalRows, totalColumns: reply.totalColumns };
    totalRows = reply.totalRows;
    totalColumns = reply.totalColumns;
    clipped ||= Boolean(reply.clipped);
    // A reply can hold no rows when the window starts past the used range or a single row
    // exceeds the cap; stop instead of asking for the same window again.
    if (reply.rows.length === 0) break;
    for (const row of reply.rows) rows.push(padRow(row, columnCount));
    start = reply.start + reply.rows.length;
    if (start >= totalRows) break;
  }
  return { loading: false as const, rows, totalRows, totalColumns, clipped };
}

export function createSheetLoader(transport: SheetTransport, publish: (state: SheetViewerState) => void,
  options: { pollMs?: number; maxPollMs?: number } = {}) {
  const pollMs = options.pollMs ?? SHEET_POLL_MS;
  const maxPollMs = options.maxPollMs ?? SHEET_POLL_MAX_MS;
  let state: SheetViewerState = { ...initial };
  let generation = 0;
  let polls = 0;
  let asked: SheetRange | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = (next: Partial<SheetViewerState>) => { state = { ...state, ...next }; publish(state); };
  const stopPolling = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };

  /** Close the handle the view holds — unmount, Reload, or 5 minutes hidden (R5). */
  async function release() {
    generation++;
    stopPolling();
    const handle = state.workbook?.handle;
    update({ workbook: undefined, window: undefined, busy: false, loading: false, progress: undefined });
    if (handle) await transport.close(handle).catch(() => undefined);
  }

  async function run(range: SheetRange, options: { reload?: boolean; reopened?: boolean } = {}) {
    const ticket = ++generation;
    stopPolling();
    polls = 0;
    asked = range;
    update({ busy: true, error: undefined, changed: false, ...(options.reload ? { window: undefined } : {}) });
    try {
      if (!state.workbook || options.reload) {
        if (state.workbook) await transport.close(state.workbook.handle).catch(() => undefined);
        update({ workbook: undefined, window: undefined, loading: true, progress: undefined, totalRows: 0, totalColumns: 0 });
        const workbook = await transport.open();
        if (ticket !== generation) {
          // The view moved on while the workbook opened (another window, another path, unmount):
          // hand the fresh handle straight back, or its helper would outlive the view (R5).
          await transport.close(workbook.handle).catch(() => undefined);
          return;
        }
        const sheet = Math.min(state.sheet, Math.max(0, workbook.sheets.length - 1));
        update({ workbook, sheet, window: undefined, totalRows: 0, totalColumns: 0 });
      }
      await step(range, ticket, 0, options.reopened === true);
    } catch (error) {
      if (ticket === generation) update({ busy: false, loading: false, progress: undefined, window: undefined, error });
    }
  }

  async function step(range: SheetRange, ticket: number, attempt: number, reopened: boolean) {
    const workbook = state.workbook;
    if (!workbook || ticket !== generation) return;
    let read: Awaited<ReturnType<typeof readRectangle>>;
    try {
      read = await readRectangle(transport, workbook.handle, state.sheet, range, () => ticket === generation);
    } catch (error) {
      if (ticket !== generation) return;
      const code = sheetErrorCode(error);
      if (code === 'sheet_not_found' && !reopened) {
        // A forgotten handle or another Local file access setting: reopen once, then retry.
        await run(range, { reload: true, reopened: true });
        return;
      }
      if (code === 'file_changed') {
        // Keep nothing from the old version; Reload starts a fresh handle and a fresh token (R6).
        update({ busy: false, loading: false, progress: undefined, window: undefined, changed: true });
        return;
      }
      throw error;
    }
    if (ticket !== generation || !read) return;
    if (read.loading) {
      polls = attempt;
      update({ loading: true, busy: true, progress: read.progress, totalRows: read.totalRows, totalColumns: read.totalColumns });
      const delay = Math.min(maxPollMs, pollMs * 2 ** Math.min(attempt, 3));
      stopPolling();
      timer = setTimeout(() => { timer = undefined; void step(range, ticket, attempt + 1, reopened).catch(error => {
        if (ticket === generation) update({ busy: false, loading: false, progress: undefined, window: undefined, error });
      }); }, delay);
      return;
    }
    update({
      loading: false, busy: false, progress: undefined, changed: false, error: undefined,
      totalRows: read.totalRows, totalColumns: read.totalColumns,
      window: { ...range, rows: read.rows, clipped: read.clipped },
    });
  }

  return {
    state: () => state,
    /** First read, Reload (fresh handle and change token) or a new window in the loaded sheet. */
    load: (range: SheetRange) => run(range),
    reload: () => run(asked ?? { start: 0, count: 0, columnStart: 0, columnCount: 0 }, { reload: true }),
    /** Another sheet tab: keep the handle, drop the window, ask for the top of the new sheet. */
    selectSheet: async (sheet: number, range: SheetRange) => {
      update({ sheet, window: undefined, totalRows: 0, totalColumns: 0, progress: undefined });
      await run(range);
    },
    /** R5: after 5 minutes hidden the helper goes away; showing the tab again calls `load`. */
    release,
    dispose() { generation++; stopPolling(); const handle = state.workbook?.handle; if (handle) void transport.close(handle).catch(() => undefined); },
    polls: () => polls,
  };
}

export type SheetLoader = ReturnType<typeof createSheetLoader>;

/** Reads a selection the resident window does not hold, in row chunks (R15). Returns the cells
 * row-major, `null` where the sheet has none. Stops at `maxCells` and answers `tooLarge`. */
export async function readSelection(transport: SheetTransport, handle: string, sheet: number, selection: {
  rowStart: number; rowEnd: number; columnStart: number; columnEnd: number;
}, maxCells = SHEET_COPY_MAX_CELLS) {
  const rows = selection.rowEnd - selection.rowStart + 1;
  const columns = selection.columnEnd - selection.columnStart + 1;
  if (rows * columns > maxCells) return { tooLarge: true as const };
  const out: SheetCell[][] = Array.from({ length: rows }, () => [] as SheetCell[]);
  for (let rowOffset = 0; rowOffset < rows; rowOffset += SHEET_REQUEST_ROWS) {
    const count = Math.min(SHEET_REQUEST_ROWS, rows - rowOffset);
    for (let columnOffset = 0; columnOffset < columns; columnOffset += SHEET_REQUEST_COLUMNS) {
      const columnCount = Math.min(SHEET_REQUEST_COLUMNS, columns - columnOffset);
      const read = await readRectangle(transport, handle, sheet, {
        start: selection.rowStart + rowOffset, count,
        columnStart: selection.columnStart + columnOffset, columnCount,
      });
      if (!read) return { loading: true as const };
      if (read.loading) return { loading: true as const };
      for (const [index, value] of read.rows.entries()) out[rowOffset + index].push(...value.slice(0, columnCount));
    }
  }
  return { tooLarge: false as const, rows: out };
}
