import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SHEET_POLL_MAX_MS, SHEET_POLL_MS, createSheetLoader, readSelection, sheetErrorCode,
  type SheetCell, type SheetRowsReply, type SheetTransport, type SheetViewerState, type SheetWorkbook,
} from './sheetWindow';
import type { SheetRange } from './sheetGrid';

const workbook = (sheets = ['Sheet1']): SheetWorkbook => ({
  handle: 'a'.repeat(32), size: 1024, changeToken: 'v1',
  sheets: sheets.map((name, index) => ({ name, visible: index === 0 })),
});
const ready = (rows: SheetCell[][], overrides: Partial<SheetRowsReply> = {}): SheetRowsReply => ({
  state: 'ready', totalRows: 100, totalColumns: 8, start: 0, columnStart: 0, rows, clipped: false, ...overrides,
});
const loading = (progress = 0): SheetRowsReply => ({
  state: 'loading', progress, totalRows: 0, totalColumns: 0, start: 0, columnStart: 0, rows: [],
});
const range = (start = 0, count = 10, columnStart = 0, columnCount = 4): SheetRange => ({ start, count, columnStart, columnCount });
const grid = (count: number, columns: number, tag = 'x'): SheetCell[][] =>
  Array.from({ length: count }, (_, row) => Array.from({ length: columns }, (_, column) => `${tag}${row}:${column}`));
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));

function harness(rows: (request: Parameters<SheetTransport['rows']>[0]) => Promise<SheetRowsReply>, sheets?: string[]) {
  const states: SheetViewerState[] = [];
  const calls: Array<Parameters<SheetTransport['rows']>[0]> = [];
  let opens = 0, closes = 0;
  const transport: SheetTransport = {
    open: async () => { opens++; return workbook(sheets); },
    rows: async request => { calls.push(request); return rows(request); },
    close: async () => { closes++; return null; },
  };
  const loader = createSheetLoader(transport, state => states.push(state), { pollMs: 5, maxPollMs: 10 });
  return { loader, states, calls, counts: () => ({ opens, closes }), last: () => states.at(-1)! };
}

test('error codes are read from a code or from the message', () => {
  assert.equal(sheetErrorCode({ code: 'file_changed', message: 'x' }), 'file_changed');
  assert.equal(sheetErrorCode(Error('sheet_not_found: handle')), 'sheet_not_found');
  assert.equal(sheetErrorCode(Error('something else')), undefined);
});

test('the poll interval starts at 300 ms and backs off to 1 s', () => {
  assert.equal(SHEET_POLL_MS, 300);
  assert.equal(SHEET_POLL_MAX_MS, 1000);
});

test('a stale reply after a newer load is dropped', async () => {
  const replies: Array<(value: SheetRowsReply) => void> = [];
  const { loader, last } = harness(() => new Promise(resolve => replies.push(resolve)));
  const first = loader.load(range(0));
  while (!replies.length) await delay(1);
  const second = loader.load(range(20));
  while (replies.length < 2) await delay(1);
  replies[1](ready(grid(10, 4, 'new'), { start: 20 }));
  await second;
  replies[0](ready(grid(10, 4, 'old'), { start: 0 }));
  await first;
  assert.equal(last().window?.start, 20);
  assert.equal(last().window?.rows[0][0], 'new0:0');
});

test('a loading reply is polled with backoff until the sheet is ready', async () => {
  let polls = 0;
  const { loader, states, last, calls } = harness(async request => (++polls < 3 ? loading(polls / 4)
    : ready(grid(request.count, request.columnCount), { start: request.start })));
  await loader.load(range());
  const deadline = Date.now() + 2_000;
  while (last().busy && Date.now() < deadline) await delay(2);
  assert.equal(polls, 3);
  const progresses = states.filter(state => state.loading && typeof state.progress === 'number').map(state => state.progress);
  assert.deepEqual(progresses, [0.25, 0.5]);
  assert.equal(last().loading, false);
  assert.equal(last().busy, false);
  assert.equal(last().window?.rows.length, 10);
  assert.equal(calls.length, 3);
});

test('a trimmed reply is continued from where it ended', async () => {
  const { loader, last, calls } = harness(async request => ready(
    grid(Math.min(2, request.count), request.columnCount, `r${request.start}-`),
    { start: request.start, totalRows: 6, totalColumns: 3 },
  ));
  await loader.load(range(0, 6, 0, 3));
  assert.equal(last().window?.rows.length, 6);
  assert.deepEqual(calls.map(call => call.start), [0, 2, 4]);
  assert.equal(last().window?.rows[5][0], 'r4-1:0');
});

test('file_changed clears the window and keeps it cleared until Reload', async () => {
  let fail = false;
  const { loader, last, counts } = harness(async () => {
    if (fail) throw Object.assign(new Error('file_changed'), { code: 'file_changed' });
    return ready(grid(2, 2));
  });
  await loader.load(range());
  assert.ok(last().window);
  fail = true;
  await loader.load(range(2));
  assert.equal(last().window, undefined);
  assert.equal(last().changed, true);
  assert.equal(last().busy, false);
  assert.equal(counts().opens, 1);
  fail = false;
  await loader.reload();
  assert.equal(last().changed, false);
  assert.ok(last().window);
  assert.equal(counts().opens, 2);
  assert.equal(counts().closes, 1);
});

test('sheet_not_found reopens once and retries the same window', async () => {
  let first = true;
  const { loader, last, calls, counts } = harness(async request => {
    if (first) { first = false; throw Object.assign(new Error('sheet_not_found'), { code: 'sheet_not_found' }); }
    return ready(grid(2, 2), { start: request.start });
  });
  await loader.load(range(4, 2));
  assert.equal(counts().opens, 2);
  assert.equal(counts().closes, 1);
  assert.deepEqual(calls.map(call => call.start), [4, 4]);
  assert.ok(last().window);
  assert.equal(last().error, undefined);
});

test('sheet_not_found twice is an error, not an endless reopen', async () => {
  const { loader, last, counts } = harness(async () => { throw Object.assign(new Error('sheet_not_found'), { code: 'sheet_not_found' }); });
  await loader.load(range());
  assert.equal(counts().opens, 2);
  assert.equal(last().window, undefined);
  assert.equal(sheetErrorCode(last().error), 'sheet_not_found');
});

test('release closes the handle and a new load opens another', async () => {
  const { loader, last, counts } = harness(async request => ready(grid(1, 1), { start: request.start }));
  await loader.load(range());
  await loader.release();
  assert.equal(counts().closes, 1);
  assert.equal(last().window, undefined);
  assert.equal(last().workbook, undefined);
  await loader.load(range());
  assert.equal(counts().opens, 2);
});

test('selecting a sheet keeps the handle and drops the old window', async () => {
  const { loader, last, calls, counts } = harness(async request => ready(grid(1, 1, `s${request.sheet}`), { start: request.start }), ['One', 'Two']);
  await loader.load(range());
  await loader.selectSheet(1, range());
  assert.equal(counts().opens, 1);
  assert.equal(last().sheet, 1);
  assert.equal(last().window?.rows[0][0], 's10:0');
  assert.equal(calls.at(-1)?.sheet, 1);
});

test('a handle that arrives after the view moved on is closed instead of leaking a helper', async () => {
  let settle!: (value: SheetWorkbook) => void;
  const opened = new Promise<SheetWorkbook>(resolve => { settle = resolve; });
  const closed: string[] = [];
  const states: SheetViewerState[] = [];
  const transport: SheetTransport = {
    open: () => opened,
    rows: async request => ready(grid(1, 1), { start: request.start }),
    close: async handle => { closed.push(handle); return null; },
  };
  const loader = createSheetLoader(transport, state => states.push(state));
  const pending = loader.load(range());
  loader.dispose();
  settle(workbook());
  await pending;
  assert.deepEqual(closed, ['a'.repeat(32)]);
  assert.equal(states.some(state => state.window), false);
});

test('a selection larger than the budget says so instead of being fetched', async () => {
  const transport: SheetTransport = {
    open: async () => workbook(), close: async () => null,
    rows: async () => ready(grid(1, 1)),
  };
  const tooLarge = await readSelection(transport, workbook().handle, 0, {
    rowStart: 0, rowEnd: 199, columnStart: 0, columnEnd: 199,
  }, 10_000);
  assert.deepEqual(tooLarge, { tooLarge: true });
});

test('a selection is read in chunks and keeps its rectangle shape', async () => {
  const calls: Array<Parameters<SheetTransport['rows']>[0]> = [];
  const transport: SheetTransport = {
    open: async () => workbook(), close: async () => null,
    rows: async request => {
      calls.push(request);
      const rows = Array.from({ length: request.count }, (_, row) =>
        Array.from({ length: request.columnCount }, (_, column) => `${request.start + row},${request.columnStart + column}`));
      return ready(rows, { start: request.start, columnStart: request.columnStart, totalRows: 400, totalColumns: 300 });
    },
  };
  const result = await readSelection(transport, workbook().handle, 0, { rowStart: 5, rowEnd: 305, columnStart: 2, columnEnd: 221 }, 100_000);
  assert.equal(result.tooLarge, false);
  assert.equal(result.rows?.length, 301);
  assert.equal(result.rows?.[0][0], '5,2');
  assert.equal(result.rows?.[300][219], '305,221');
  // 301 rows in two row chunks; 220 columns in two column chunks.
  assert.equal(calls.length, 4);
});

test('dispose prevents a pending reply from being published', async () => {
  const replies: Array<(value: SheetRowsReply) => void> = [];
  const { loader, states } = harness(() => new Promise(resolve => replies.push(resolve)));
  const pending = loader.load(range());
  while (!replies.length) await delay(1);
  loader.dispose();
  replies[0](ready(grid(1, 1)));
  await pending;
  assert.equal(states.some(state => state.window), false);
});
