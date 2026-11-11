import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Method, RequestParams, RequestResult } from '@threadterm/protocol';
import { LocalFileRouter, type FileRequestTarget } from './router.ts';
import {
  SHEET_CHUNK_BYTES, SHEET_HANDLE_FORGET_MS, SHEET_IDLE_MS, SHEET_MAX_READERS, createSheetHost, isSheetMethod,
  readerStopCode, sheetFormat, type SheetHost, type SheetReaderFactory, type SheetReaderProcess,
} from './sheet-host.ts';
import type { ReaderCommand, ReaderMessage, ReaderSheetInfo } from './sheet-reader-core.ts';

/** A stand-in for the WebAssembly core behind the reader: it answers the reader protocol and
 * records what the host sent, so the host is tested without Electron or the module. */
function fakeReader(options: {
  sheets?: ReaderSheetInfo[];
  failOpen?: string;
  /** Bytes the fake reports as loaded per sheet; `rows` answers a text cell per row. */
  rows?: (request: { sheet: number; start: number; count: number; columnStart: number; columnCount: number }) => { state: 'ready'; rows: unknown[]; totalRows: number; totalColumns: number };
  /** Runs after each feed; can change the file mid-read (`file_changed`). */
  afterFeed?: (index: number) => void | Promise<void>;
  /** Never answer `fed`: the credit window is held. */
  stall?: boolean;
  /** Record `rows` but never answer: an in-flight request for the crash test. */
  holdRows?: boolean;
  /** Milliseconds a first window waits before the fake calls the sheet loaded. */
  loadDelay?: number;
  loadFails?: string;
} = {}) {
  const listeners: ((message: ReaderMessage) => void)[] = [];
  const exits: ((code: number | null) => void)[] = [];
  const commands: ReaderCommand[] = [];
  const chunks: Uint8Array[] = [];
  const state = { killed: 0, killedAt: [] as number[], loading: new Set<number>(), loaded: new Set<number>() };
  const post = (message: ReaderMessage) => { for (const listener of listeners) listener(message); };
  const process: SheetReaderProcess = {
    post(command) {
      commands.push(command);
      switch (command.t) {
        case 'feed': {
          chunks.push(command.chunk);
          const index = chunks.length;
          if (options.stall) return;
          void Promise.resolve(options.afterFeed?.(index)).then(() => {
            post({ t: 'fed', bytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0) });
          });
          break;
        }
        case 'open':
          if (options.failOpen) post({ t: 'failed', code: options.failOpen });
          else post({ t: 'opened', sheets: options.sheets ?? [{ name: 'Sheet1', visible: true }] });
          break;
        case 'rows': {
          if (options.holdRows) break;
          const { sheet } = command.request;
          if (state.loading.has(sheet)) {
            post({ t: 'rows', id: command.id, reply: { ok: true, result: { state: 'loading', totalRows: 0, totalColumns: 0, start: command.request.start, columnStart: command.request.columnStart, rows: [] } } });
            break;
          }
          if (options.loadFails) {
            post({ t: 'rows', id: command.id, reply: { ok: false, code: options.loadFails } });
            break;
          }
          if ((options.sheets ?? [{ name: 'Sheet1', visible: true }])[sheet] === undefined) {
            post({ t: 'rows', id: command.id, reply: { ok: false, code: 'sheet_not_found' } });
            break;
          }
          // First window of a sheet: answer `loading`, then load it (as the real reader does).
          const rowState = options.rows?.(command.request);
          if (!state.loaded.has(sheet)) {
            state.loading.add(sheet);
            post({ t: 'rows', id: command.id, reply: { ok: true, result: { state: 'loading', totalRows: 0, totalColumns: 0, start: command.request.start, columnStart: command.request.columnStart, rows: [] } } });
            post({ t: 'load-started', sheet });
            setTimeout(() => {
              state.loading.delete(sheet);
              state.loaded.add(sheet);
              post({ t: 'load-done', sheet });
            }, options.loadDelay ?? 25);
            break;
          }
          post({ t: 'rows', id: command.id, reply: { ok: true, result: { state: 'ready', totalRows: rowState?.totalRows ?? 3, totalColumns: rowState?.totalColumns ?? 2, start: command.request.start, columnStart: command.request.columnStart, rows: rowState?.rows ?? [['x']] } } });
          break;
        }
        case 'memory': post({ t: 'memory', rss: 1024, peak: 2048, linear: 4096 }); break;
        default: break;
      }
    },
    onMessage(listener) {
      listeners.push(listener);
      // The real reader posts `ready` once the module is instantiated, after the host attached
      // its listener; a restart registers a new listener, so every start gets a `ready`.
      setImmediate(() => post({ t: 'ready' }));
    },
    onExit(listener) { exits.push(listener); },
    kill() { state.killed += 1; state.killedAt.push(Date.now()); },
  };
  return { process, commands, chunks, state, exit: (code: number | null) => { for (const listener of exits) listener(code); } };
}

function lease() {
  const log: string[] = [];
  let active = 0;
  let maxActive = 0;
  return {
    log,
    active: () => active,
    maxActive: () => maxActive,
    run<T>(action: () => Promise<T>): Promise<T> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      log.push('begin');
      return action().finally(() => { active -= 1; log.push('release'); });
    },
  };
}

async function workspace() {
  const folder = await mkdtemp(join(tmpdir(), 'tt-sheet-main-host-'));
  await mkdir(folder, { recursive: true });
  return folder;
}

function host(folder: string, reader: ReturnType<typeof fakeReader>, overrides: {
  now?: () => number; access?: ReturnType<typeof lease>; startReader?: SheetReaderFactory; sweepMs?: number;
} = {}) {
  const access = overrides.access ?? lease();
  const readers = { count: 0 };
  const created: ReturnType<typeof fakeReader>[] = [];
  const sheet = createSheetHost({
    access,
    workspaceRoot: async () => folder,
    externalPath: async id => { if (id === 'registered') return join(folder, 'workbook.xlsx'); throw new Error('external_file_unknown'); },
    startReader: overrides.startReader ?? (() => { readers.count += 1; created.push(reader); return reader.process; }),
    wasmPath: join(folder, 'sheet-core.wasm'),
    now: overrides.now,
    sweepMs: overrides.sweepMs,
  });
  return { sheet, access, readers, created };
}

const open = (sheet: SheetHost, owner = 'window-1') => sheet.request('filesystem.sheet.open', { projectId: 'project', path: 'workbook.xlsx' }, owner);

test('sheet methods are routed to the main host only under the main backend', async () => {
  const routes: string[] = [];
  const target = (name: string): FileRequestTarget => ({
    request: <M extends Method>(method: M, _params: RequestParams<M>) => { routes.push(`${name}:${method}`); return Promise.resolve(null as RequestResult<M>); },
  });
  const runtime = target('runtime');
  const main = target('main');
  const router = new LocalFileRouter({ load: async () => 'runtime', save: async () => {} }, main);
  for (const method of ['filesystem.sheet.open', 'filesystem.external.sheet.open', 'filesystem.sheet.rows', 'filesystem.sheet.close'] as const) {
    assert.equal(isSheetMethod(method), true);
    await router.request('local', runtime, method, {} as RequestParams<typeof method>);
    await router.request('peer', runtime, method, {} as RequestParams<typeof method>);
  }
  await router.setBackend('main');
  await router.request('local', runtime, 'filesystem.sheet.rows', { handle: 'a'.repeat(32), sheet: 0, start: 0, count: 1 });
  assert.deepEqual(routes.filter(route => route.startsWith('main:')), ['main:filesystem.sheet.rows']);
  assert.equal(routes.filter(route => route === 'runtime:filesystem.sheet.open').length, 2, 'remote views keep their host runtime');
});

test('runtime sheet handles are closed on the runtime when the setting moves to main or their window goes', async () => {
  const closed: string[] = [];
  let opened = 0;
  const runtime: FileRequestTarget = {
    request: <M extends Method>(method: M, params: RequestParams<M>) => {
      if (method === 'filesystem.sheet.open') return Promise.resolve({ handle: `h${++opened}`, size: 1, changeToken: 't', sheets: [] } as RequestResult<M>);
      if (method === 'filesystem.sheet.close') closed.push((params as { handle: string }).handle);
      return Promise.resolve(null as RequestResult<M>);
    },
  };
  const main: FileRequestTarget = { request: <M extends Method>() => Promise.resolve(null as RequestResult<M>) };
  const router = new LocalFileRouter({ load: async () => 'runtime', save: async () => {} }, main);
  const scope = { projectId: 'project', path: 'a.xlsx' };
  await router.request('local', runtime, 'filesystem.sheet.open', scope, { owner: 'window-1' });
  await router.request('local', runtime, 'filesystem.sheet.open', scope, { owner: 'window-2' });
  await router.request('local', runtime, 'filesystem.sheet.open', scope, { owner: 'window-2' });
  await router.request('local', runtime, 'filesystem.sheet.close', { handle: 'h3' }, { owner: 'window-2' });
  closed.length = 0;
  router.releaseOwner('window-1');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(closed, ['h1'], 'a closed window takes its runtime helper with it');
  await router.setBackend('main');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(closed, ['h1', 'h2'], 'switching to main closes what the runtime still holds, once');
  router.releaseOwner('window-2');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(closed, ['h1', 'h2']);
});

test('the workbook is read in 1 MiB chunks through one reused buffer inside the access lease', async () => {
  const folder = await workspace();
  try {
    const bytes = 3 * SHEET_CHUNK_BYTES - 17;
    await writeFile(join(folder, 'workbook.xlsx'), Buffer.alloc(bytes, 7));
    const reader = fakeReader();
    const { sheet, access } = host(folder, reader);
    const opened = await open(sheet);
    assert.equal(opened.size, bytes, 'the wire reply reports the file size');
    assert.equal(opened.sheets.length, 1);
    assert.equal(reader.chunks.length, 3, 'three chunks for just under 3 MiB');
    assert.ok(reader.chunks.every(chunk => chunk.byteLength <= SHEET_CHUNK_BYTES), 'no chunk exceeds the budget');
    assert.equal(reader.chunks.reduce((total, chunk) => total + chunk.byteLength, 0), bytes, 'the whole file reached the reader');
    assert.equal(new Set(reader.chunks.map(chunk => chunk.buffer)).size, 1, 'one buffer is reused for every chunk');
    assert.deepEqual(access.log, ['begin', 'release'], 'the lease covers the read and is released after the last chunk');
    assert.equal(access.active(), 0);
    assert.equal((await sheet.request('filesystem.sheet.close', { handle: opened.handle }, 'window-1')), null);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('a workbook that changes mid-read fails with file_changed and leaves no lease open', async () => {
  const folder = await workspace();
  try {
    const path = join(folder, 'workbook.xlsx');
    await writeFile(path, Buffer.alloc(2 * SHEET_CHUNK_BYTES, 1));
    const reader = fakeReader({ afterFeed: async index => { if (index === 1) await writeFile(path, Buffer.alloc(2 * SHEET_CHUNK_BYTES + 5, 2)); } });
    const { sheet, access } = host(folder, reader);
    await assert.rejects(open(sheet), /file_changed/);
    assert.equal(access.active(), 0, 'the lease is released on the failure path too');
    assert.equal(sheet.snapshot().handles, 0, 'no handle survives a failed open');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('a sheet loads without holding a request: polls answer loading and the reader is not asked again', async () => {
  const folder = await workspace();
  try {
    await writeFile(join(folder, 'workbook.xlsx'), Buffer.alloc(16, 1));
    const reader = fakeReader();
    const { sheet } = host(folder, reader);
    const opened = await open(sheet);
    const first = await sheet.request('filesystem.sheet.rows', { handle: opened.handle, sheet: 0, start: 0, count: 5 }, 'window-1');
    assert.equal(first.state, 'loading');
    const second = await sheet.request('filesystem.sheet.rows', { handle: opened.handle, sheet: 0, start: 0, count: 5 }, 'window-1');
    assert.equal(second.state, 'loading', 'a poll during the load is answered by the host');
    assert.equal(reader.commands.filter(command => command.t === 'rows').length, 1, 'the reader was asked once');
    await new Promise(resolve => setTimeout(resolve, 60));
    const ready = await sheet.request('filesystem.sheet.rows', { handle: opened.handle, sheet: 0, start: 0, count: 5 }, 'window-1');
    assert.equal(ready.state, 'ready');
    assert.deepEqual(ready.rows, [['x']]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('handles belong to the window that opened them, close is idempotent, and a reset drops them', async () => {
  const folder = await workspace();
  try {
    await writeFile(join(folder, 'workbook.xlsx'), Buffer.alloc(8, 1));
    const reader = fakeReader();
    const { sheet } = host(folder, reader);
    const opened = await open(sheet, 'window-1');
    assert.match(opened.handle, /^[0-9a-f]{32}$/, 'a handle is 128 random bits');
    await assert.rejects(sheet.request('filesystem.sheet.rows', { handle: opened.handle, sheet: 0, start: 0, count: 1 }, 'window-2'), /sheet_not_found/);
    assert.equal(await sheet.request('filesystem.sheet.close', { handle: opened.handle }, 'window-2'), null);
    assert.equal(sheet.snapshot().handles, 1, 'another window cannot close it');
    assert.equal(await sheet.request('filesystem.sheet.close', { handle: opened.handle }, 'window-1'), null);
    assert.equal(await sheet.request('filesystem.sheet.close', { handle: opened.handle }, 'window-1'), null, 'close is idempotent');
    assert.equal(sheet.snapshot().readers, 0);
    const second = await open(sheet, 'window-1');
    sheet.reset();
    await assert.rejects(sheet.request('filesystem.sheet.rows', { handle: second.handle, sheet: 0, start: 0, count: 1 }, 'window-1'), /sheet_not_found/);
    assert.deepEqual(sheet.snapshot(), { handles: 0, readers: 0, owners: [] });
    sheet.releaseOwner('window-1');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('a file that changes after open is file_changed, and a vanished file is too', async () => {
  const folder = await workspace();
  try {
    const path = join(folder, 'workbook.xlsx');
    await writeFile(path, Buffer.alloc(8, 1));
    const reader = fakeReader();
    const { sheet } = host(folder, reader);
    const opened = await open(sheet);
    await writeFile(path, Buffer.alloc(9, 1));
    await assert.rejects(sheet.request('filesystem.sheet.rows', { handle: opened.handle, sheet: 0, start: 0, count: 1 }, 'window-1'), /file_changed/);
    assert.equal(sheet.snapshot().handles, 0, 'the changed handle is dropped so the client reopens');
    const again = await open(sheet);
    await rm(path);
    await assert.rejects(sheet.request('filesystem.sheet.rows', { handle: again.handle, sheet: 0, start: 0, count: 1 }, 'window-1'), /file_changed/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('a reader crash is that handle only; the next request starts a fresh reader', async () => {
  const folder = await workspace();
  try {
    await writeFile(join(folder, 'workbook.xlsx'), Buffer.alloc(8, 1));
    const first = fakeReader({ holdRows: true });
    const second = fakeReader();
    let started = 0;
    const { sheet } = host(folder, first, {
      startReader: () => { started += 1; return started === 1 ? first.process : second.process; },
    });
    const opened = await open(sheet);
    const pending = sheet.request('filesystem.sheet.rows', { handle: opened.handle, sheet: 0, start: 0, count: 1 }, 'window-1');
    pending.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 10));
    // A memory stop: the reader's own exit code, as Windows reports a Rust abort.
    first.exit(0xC000_0409 - 2 ** 32);
    await assert.rejects(pending, /sheet_out_of_memory/);
    const reloading = await sheet.request('filesystem.sheet.rows', { handle: opened.handle, sheet: 0, start: 0, count: 1 }, 'window-1');
    assert.equal(reloading.state, 'loading', 'the restart answers loading, it does not wait');
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(started, 2, 'a fresh reader was started for the same handle');
    let ready = reloading;
    for (let poll = 0; poll < 20 && ready.state !== 'ready'; poll += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
      ready = await sheet.request('filesystem.sheet.rows', { handle: opened.handle, sheet: 0, start: 0, count: 1 }, 'window-1');
    }
    assert.equal(ready.state, 'ready', 'the reloaded handle serves windows again');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('a reader that stops while a sheet loads reports it once instead of loading the sheet again', async () => {
  const folder = await workspace();
  try {
    await writeFile(join(folder, 'workbook.xlsx'), Buffer.alloc(8, 1));
    const first = fakeReader({ loadDelay: 300 });
    const second = fakeReader();
    let started = 0;
    const { sheet } = host(folder, first, {
      startReader: () => { started += 1; return started === 1 ? first.process : second.process; },
    });
    const opened = await open(sheet);
    const rows = () => sheet.request('filesystem.sheet.rows', { handle: opened.handle, sheet: 0, start: 0, count: 1 }, 'window-1');
    assert.equal((await rows()).state, 'loading', 'the first window starts the load');
    assert.equal((await rows()).state, 'loading', 'the host answers while the reader loads');
    // The module's memory cap stops the reader mid-load; no request is waiting for it.
    first.exit(0xC000_0409 - 2 ** 32);
    await assert.rejects(rows(), /sheet_out_of_memory/);
    assert.equal(started, 1, 'no reader was started to load the same sheet again');
    // A late message from the stopped reader does not mark the sheet loaded.
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal((await rows()).state, 'loading', 'asking again starts afresh');
    assert.equal(started, 2);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('the idle time ends the reader but keeps the handle; a stale handle is forgotten', async () => {
  const folder = await workspace();
  try {
    await writeFile(join(folder, 'workbook.xlsx'), Buffer.alloc(8, 1));
    let clock = 1_000_000;
    const reader = fakeReader();
    const { sheet } = host(folder, reader, { now: () => clock, sweepMs: 250 });
    const opened = await open(sheet);
    clock += SHEET_IDLE_MS + 1;
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(reader.state.killed, 1, 'the idle reader was ended');
    assert.equal(sheet.snapshot().handles, 1, 'the handle stays');
    const reloading = await sheet.request('filesystem.sheet.rows', { handle: opened.handle, sheet: 0, start: 0, count: 1 }, 'window-1');
    assert.equal(reloading.state, 'loading', 'the handle reloads instead of failing');
    await new Promise(resolve => setTimeout(resolve, 30));
    clock += SHEET_HANDLE_FORGET_MS;
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(sheet.snapshot().handles, 0, 'a handle unused for 30 minutes is forgotten');
    await assert.rejects(sheet.request('filesystem.sheet.rows', { handle: opened.handle, sheet: 0, start: 0, count: 1 }, 'window-1'), /sheet_not_found/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('at most three readers live; the least recently used idle one ends first', async () => {
  const folder = await workspace();
  try {
    for (const name of ['workbook.xlsx', 'a.xlsx', 'b.xlsx', 'c.xlsx']) await writeFile(join(folder, name), Buffer.alloc(8, 1));
    const created: ReturnType<typeof fakeReader>[] = [];
    const { sheet } = host(folder, fakeReader(), { startReader: () => { const reader = fakeReader(); created.push(reader); return reader.process; } });
    const handles: string[] = [];
    for (const name of ['workbook.xlsx', 'a.xlsx', 'b.xlsx']) {
      handles.push((await sheet.request('filesystem.sheet.open', { projectId: 'project', path: name }, 'window-1')).handle);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(sheet.snapshot().readers, 3);
    await sheet.request('filesystem.sheet.open', { projectId: 'project', path: 'c.xlsx' }, 'window-1');
    assert.equal(sheet.snapshot().readers, 3, 'the limit holds');
    assert.equal(created[0].state.killed, 1, 'the least recently used reader was ended');
    assert.equal(created[2].state.killed, 0);
    assert.equal(handles.length, 3);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('the extension picks the format and an unsupported name is refused before any read', async () => {
  const folder = await workspace();
  try {
    await writeFile(join(folder, 'notes.txt'), 'not a workbook');
    await writeFile(join(folder, 'book.xls'), Buffer.alloc(8, 1));
    await writeFile(join(folder, 'book.xlsm'), Buffer.alloc(8, 1));
    assert.equal(sheetFormat('C:\\a\\b.XLSX'), 'xlsx');
    assert.equal(sheetFormat('C:\\a\\b.xlsm'), 'xlsx');
    assert.equal(sheetFormat('C:\\a\\b.xls'), 'xls');
    assert.equal(sheetFormat('C:\\a\\b.ods'), 'ods');
    assert.equal(sheetFormat('C:\\a\\b.docx'), undefined);
    assert.equal(sheetFormat('C:\\a\\.xlsx'), undefined);
    const reader = fakeReader();
    const { sheet } = host(folder, reader);
    await assert.rejects(sheet.request('filesystem.sheet.open', { projectId: 'project', path: 'notes.txt' }, 'window-1'), /unsupported_document/);
    assert.equal(reader.commands.length, 0, 'nothing was fed to a reader');
    await assert.rejects(sheet.request('filesystem.sheet.open', { projectId: 'project', path: '../outside.xlsx' }, 'window-1'), /invalid_path/);
    // A registered external file resolves by ID only.
    await writeFile(join(folder, 'workbook.xlsx'), Buffer.alloc(8, 1));
    const external = await sheet.request('filesystem.external.sheet.open', { id: 'registered' }, 'window-1');
    assert.equal(external.size, 8);
    await assert.rejects(sheet.request('filesystem.external.sheet.open', { id: 'unknown' }, 'window-1'), /external_file_unknown/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('the reader stop code separates a memory stop from a failed reader', () => {
  assert.equal(readerStopCode(0xC000_0409, 0), 'sheet_out_of_memory');
  assert.equal(readerStopCode(0xC000_0017, 0), 'sheet_out_of_memory');
  assert.equal(readerStopCode(1, 2 ** 31 - 1), 'sheet_out_of_memory');
  assert.equal(readerStopCode(1, 64 * 1024 * 1024), 'sheet_worker_failed');
  assert.equal(readerStopCode(null, 0), 'sheet_worker_failed');
  assert.equal(SHEET_MAX_READERS, 3);
  assert.equal(SHEET_IDLE_MS, 300_000);
  assert.equal(SHEET_HANDLE_FORGET_MS, 30 * 60 * 1000);
  assert.equal(SHEET_CHUNK_BYTES, 1024 * 1024);
});
