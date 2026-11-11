/**
 * The Local file access = main sheet host (`design.md` §3.4, §3.5): the handle table, the
 * reader lifecycle and the four wire methods, for the main backend.
 *
 * R22 is the rule this module exists for. With Local file access = main the workbook is
 * opened and read only inside ThreadTerm.exe: this module reads it with the same bounded,
 * identity-checked reader `filesystem.readWindow` uses, inside the module's access lease,
 * and streams it in 1 MiB chunks to a reader process that is also ThreadTerm.exe (an
 * Electron `utilityProcess` running the WebAssembly sheet core). The bytes are never sent to
 * the runtime, to its `--sheet-worker` helper or to any other executable, and are never
 * written to disk. The reader opens no files itself.
 *
 * The rules are the runtime host's (`runtime/src/sheet_preview.rs`): 128-bit handles bound to
 * the window that opened them, `close` idempotent, 300 s idle, three readers, handles
 * forgotten after 30 minutes, the `read_window_path` change token, a crash or a memory stop
 * as an error for that handle only, and no request served while a reader loads.
 */
import { randomBytes } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { FileScope, RequestResult, SheetInfo, SheetRows } from '@threadterm/protocol';
import { OFFICE_PREVIEW_MAX_BYTES } from '@threadterm/protocol';
import { fileChangeToken, validateOpenFilePath } from './bounded-read.js';
import { containedExisting } from './paths.js';
import type { ReaderCommand, ReaderMessage, ReaderSheetRows } from './sheet-reader-core.js';

/** `design.md` §3.5: no `rows` for this long ends the reader. The handle stays. */
export const SHEET_IDLE_MS = 300_000;
/** At most this many live readers; the least recently used idle one ends first. */
export const SHEET_MAX_READERS = 3;
/** A handle that sees no request for this long is forgotten (`sheet_not_found`). */
export const SHEET_HANDLE_FORGET_MS = 30 * 60_000;
/** The feed window: one reused buffer, one chunk in flight (the spike held +47 MiB otherwise). */
export const SHEET_CHUNK_BYTES = 1024 * 1024;
export const SHEET_MAX_BYTES = OFFICE_PREVIEW_MAX_BYTES;
/** S2: the WebAssembly module's link-time memory cap. */
export const SHEET_READER_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const SHEET_SWEEP_MS = 30_000;
const SWEEP_MIN_MS = 250;

/** The reader process, as the host needs it. Tests inject a fake that speaks the protocol. */
export type SheetReaderProcess = {
  post(message: ReaderCommand): void;
  onMessage(listener: (message: ReaderMessage) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
};
export type SheetReaderFactory = (input: { wasm: string }) => SheetReaderProcess;

export type SheetFormat = 'xlsx' | 'xlsb' | 'xls' | 'ods';

export type SheetHostOptions = {
  /** The module's access lease (`local-file-backend.md`): the workbook is read inside it. */
  access: { run<T>(action: () => Promise<T>): Promise<T> };
  /** The workspace root a scope resolves to — `desktop.files.context`, as `filesystem.readWindow`. */
  workspaceRoot: (scope: FileScope) => Promise<string>;
  /** A **registered** external file's canonical path, by ID only. */
  externalPath: (id: string) => Promise<string>;
  startReader: SheetReaderFactory;
  /** Where `desktop-dist/sheet-core.wasm` is; the reader loads it. */
  wasmPath: string;
  now?: () => number;
  sweepMs?: number;
  log?: (line: string) => void;
};

type Handle = {
  owner: string;
  path: string;
  format: SheetFormat;
  size: number;
  changeToken: string;
  sheets: SheetInfo[];
  reader?: ReaderLink;
  /** A reader is being started for this handle; `rows` answers `loading` meanwhile. */
  starting: boolean;
  /** That start failed; the next `rows` reports it once. */
  startFailed?: string;
  /** Sheets whose load is in flight: every `rows` answers `loading` meanwhile. */
  loading: Set<number>;
  loaded: Set<number>;
  /** A sheet the core refused (`sheet_too_complex`); it answers at once, the reader stays. */
  failures: Map<number, string>;
  lastUsed: number;
};

type Waiter = {
  match: (message: ReaderMessage) => boolean;
  settle: (message: ReaderMessage) => void;
  fail: (code: string) => void;
};

type ReaderLink = {
  process: SheetReaderProcess;
  waiters: Set<Waiter>;
  ending: boolean;
  /** Set once the reader stopped answering: every later request fails with this code. */
  stopped?: string;
  memory?: { rss: number; peak: number; linear: number };
};

export type SheetMethod = 'filesystem.sheet.open' | 'filesystem.external.sheet.open' | 'filesystem.sheet.rows' | 'filesystem.sheet.close';

export type SheetHost = {
  request(method: SheetMethod, params: unknown, owner: string): Promise<RequestResult<SheetMethod>>;
  /** The Local file access setting changed: every old handle is `sheet_not_found`. */
  reset(): void;
  /** A window was destroyed: its handles and readers go (`design.md` §3.5). */
  releaseOwner(owner: string): void;
  /** Read-only view for tests and the QA probe. */
  snapshot(): { handles: number; readers: number; owners: string[] };
};

const SHEET_METHODS = new Set([
  'filesystem.sheet.open', 'filesystem.external.sheet.open', 'filesystem.sheet.rows', 'filesystem.sheet.close',
]);
export const isSheetMethod = (method: string): boolean => SHEET_METHODS.has(method);

const fail = (code: string): never => { throw new Error(code); };

const ERROR_CODES = new Set([
  'invalid_path', 'invalid_request', 'file_too_large', 'file_changed', 'file_not_found', 'file_unavailable',
  'file_not_file', 'external_file_unknown', 'external_file_not_found', 'external_file_unavailable',
  'unsupported_document', 'document_protected', 'sheet_too_complex', 'sheet_out_of_memory',
  'sheet_worker_failed', 'sheet_not_found', 'path_escape',
]);

/** The code an error carries, for the wire (`local-file-backend.md`: codes travel in the message). */
export function sheetCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && ERROR_CODES.has(error.code)) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  for (const code of ERROR_CODES) if (message === code || message.includes(`: ${code}`) || message.endsWith(` ${code}`)) return code;
  return 'sheet_worker_failed';
}

/** `.xlsx .xlsm` → xlsx, `.xlsb`, `.xls`, `.ods`; anything else is not a sheet (`design.md` §2, D6). */
export function sheetFormat(path: string): SheetFormat | undefined {
  const name = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  switch (name.slice(dot + 1).toLowerCase()) {
    case 'xlsx': case 'xlsm': return 'xlsx';
    case 'xlsb': return 'xlsb';
    case 'xls': return 'xls';
    case 'ods': return 'ods';
    default: return undefined;
  }
}

/** `app.getAppMetrics()` under-reports a utility process on Windows, so the reader says its own
 * footprint; a stop near the module's memory cap is read as out of memory. */
export function readerStopCode(exitCode: number | null, peakBytes: number | undefined,
  limitBytes = SHEET_READER_MEMORY_BYTES): string {
  // STATUS_STACK_BUFFER_OVERRUN (Rust aborts a failed allocation) and STATUS_COMMITMENT_LIMIT,
  // as signed, unsigned and masked forms: Windows tooling reports them differently.
  const aborted = exitCode !== null && exitCode !== 0
    && [0xC000_0409, 0xC000_0017].some(code => exitCode === code || exitCode === code - 2 ** 32 || exitCode === (code & 0xff));
  if (aborted) return 'sheet_out_of_memory';
  if (typeof peakBytes === 'number' && peakBytes > 0 && peakBytes >= limitBytes / 16 * 15) return 'sheet_out_of_memory';
  return 'sheet_worker_failed';
}

const loadingReply = (start: number, columnStart: number): SheetRows => ({
  state: 'loading', totalRows: 0, totalColumns: 0, start, columnStart, rows: [],
});

export function createSheetHost(options: SheetHostOptions): SheetHost {
  const handles = new Map<string, Handle>();
  const now = options.now ?? (() => Date.now());
  let requestIds = 0;
  // One sweep timer for idle readers and forgotten handles, as the runtime host's reaper.
  const timer = setInterval(() => sweep(), Math.max(SWEEP_MIN_MS, Math.min(options.sweepMs ?? SHEET_SWEEP_MS, SHEET_SWEEP_MS)));
  (timer as { unref?: () => void }).unref?.();

  function log(line: string) { options.log?.(line); }

  function newHandleId(): string {
    return randomBytes(16).toString('hex');
  }

  function liveReaders(): number {
    let count = 0;
    for (const handle of handles.values()) if (handle.reader || handle.starting) count += 1;
    return count;
  }

  /** `design.md` §3.5: make room for one more reader; the least recently used idle one goes
   * first, and a loading one only when none is idle. */
  function makeRoom(keep: string): ReaderLink | undefined {
    if (liveReaders() < SHEET_MAX_READERS) return undefined;
    const pick = (idleOnly: boolean) => [...handles.entries()]
      .filter(([id, handle]) => id !== keep && handle.reader && (!idleOnly || handle.loading.size === 0))
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
    const chosen = pick(true) ?? pick(false);
    if (!chosen) return undefined;
    const [id, handle] = chosen;
    const link = handle.reader;
    if (link) endReader(handle, link);
    return link;
  }

  function endReader(handle: Handle, link: ReaderLink): void {
    if (handle.reader === link) {
      handle.reader = undefined;
      handle.loading.clear();
      handle.loaded.clear();
      handle.failures.clear();
    }
    stop(link, link.stopped ?? 'sheet_worker_failed');
    if (link.ending) return;
    link.ending = true;
    try { link.process.kill(); } catch { /* already gone */ }
  }

  function stop(link: ReaderLink, code: string): void {
    link.stopped ??= code;
    for (const waiter of [...link.waiters]) waiter.fail(link.stopped);
  }

  function endAll(): void {
    for (const handle of handles.values()) if (handle.reader) endReader(handle, handle.reader);
  }

  function waitFor(link: ReaderLink, match: (message: ReaderMessage) => boolean): Promise<ReaderMessage> {
    if (link.stopped) return Promise.reject(new Error(link.stopped));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        settle: message => { link.waiters.delete(waiter); resolve(message); },
        fail: code => { link.waiters.delete(waiter); reject(new Error(code)); },
      };
      link.waiters.add(waiter);
    });
  }

  function route(handle: Handle, link: ReaderLink, message: ReaderMessage): void {
    // A reader that was replaced or ended no longer speaks for the handle's sheets.
    const current = handle.reader === link;
    if (current) switch (message.t) {
      case 'load-started': handle.loading.add(message.sheet); break;
      case 'load-done':
        handle.loading.delete(message.sheet);
        handle.loaded.add(message.sheet);
        break;
      case 'load-failed':
        handle.loading.delete(message.sheet);
        handle.failures.set(message.sheet, message.code);
        break;
      case 'memory':
        link.memory = { rss: message.rss, peak: message.peak, linear: message.linear };
        // The reader measures itself: `app.getAppMetrics()` reports 40 MiB for a process that
        // holds 400 MiB (validation.md). One line per report; nothing on the wire.
        log(`sheet reader memory: rss ${Math.round(message.rss / 1048576)} MiB, peak ${Math.round(message.peak / 1048576)} MiB, wasm ${Math.round(message.linear / 1048576)} MiB`);
        break;
      case 'failed':
        stop(link, message.code);
        endReader(handle, link);
        break;
      default: break;
    }
    for (const waiter of [...link.waiters]) if (waiter.match(message)) waiter.settle(message);
  }

  function onExit(handle: Handle, link: ReaderLink, code: number | null): void {
    if (link.ending && link.stopped) { stop(link, link.stopped); return; }
    const stopCode = readerStopCode(code, link.memory?.peak);
    // A request in flight learns the code from its waiter. Otherwise (the reader stopped while
    // the host answered `loading` for it) the next `rows` reports it once; a silent restart
    // would feed and load the same sheet again, and stop again, while the client polls.
    const told = link.waiters.size > 0;
    stop(link, stopCode);
    if (!told && handle.reader === link) handle.startFailed ??= stopCode;
    endReader(handle, link);
  }

  /** Read one workbook into the reader: one reused 1 MiB buffer, one chunk in flight, the
   * bounded identity-checked reader, and the access lease released as soon as the last byte is
   * in (no file handle stays open). */
  async function feedWorkbook(link: ReaderLink, handle: Handle): Promise<void> {
    const buffer = Buffer.allocUnsafe(SHEET_CHUNK_BYTES);
    await options.access.run(async () => {
      const file = await open(handle.path, 'r');
      try {
        const before = await validateOpenFilePath(file, handle.path);
        if (!before.isFile()) fail('file_not_file');
        if (before.size > BigInt(SHEET_MAX_BYTES)) fail('file_too_large');
        if (fileChangeToken(before) !== handle.changeToken) fail('file_changed');
        const size = Number(before.size);
        let offset = 0;
        while (offset < size) {
          const wanted = Math.min(SHEET_CHUNK_BYTES, size - offset);
          let read = 0;
          while (read < wanted) {
            const result = await file.read(buffer, read, wanted - read, offset + read);
            if (!result.bytesRead) fail('file_changed');
            read += result.bytesRead;
          }
          const credit = waitFor(link, message => message.t === 'fed' || message.t === 'failed');
          // The credit window: the next chunk is not read until this one is in the reader, so
          // the main process never holds more than this one buffer.
          link.process.post({ t: 'feed', chunk: buffer.subarray(0, read) });
          const answer = await credit;
          if (answer.t === 'failed') fail(answer.code);
          offset += read;
        }
        const after = await validateOpenFilePath(file, handle.path);
        if (fileChangeToken(after) !== handle.changeToken) fail('file_changed');
      } finally {
        await file.close().catch(() => {});
      }
    });
  }

  async function startReader(handle: Handle): Promise<void> {
    const process = options.startReader({ wasm: options.wasmPath });
    const link: ReaderLink = { process, waiters: new Set(), ending: false };
    handle.reader = link;
    handle.loading.clear();
    handle.loaded.clear();
    handle.failures.clear();
    process.onMessage(message => route(handle, link, message));
    process.onExit(code => onExit(handle, link, code));
    try {
      const ready = waitFor(link, message => message.t === 'ready' || message.t === 'failed');
      const readyAnswer = await ready;
      if (readyAnswer.t === 'failed') return fail(readyAnswer.code);
      await feedWorkbook(link, handle);
      const opened = waitFor(link, message => message.t === 'opened' || message.t === 'failed');
      process.post({ t: 'open', format: handle.format });
      const answer = await opened;
      if (answer.t === 'failed') return fail(answer.code);
      if (answer.t !== 'opened') return fail('sheet_worker_failed');
      handle.sheets = answer.sheets;
      process.post({ t: 'memory' });
    } catch (error) {
      endReader(handle, link);
      throw error;
    }
  }

  function restart(handle: Handle): void {
    const id = [...handles.entries()].find(([, value]) => value === handle)?.[0];
    if (id === undefined) return;
    handle.starting = true;
    makeRoom(id);
    void startReader(handle).then(() => {
      const live = handles.get(id);
      if (live !== handle) return;
      handle.starting = false;
      handle.startFailed = undefined;
    }, error => {
      const live = handles.get(id);
      if (live !== handle) return;
      handle.starting = false;
      handle.startFailed = sheetCode(error);
    });
  }

  /** Size, existence and the `read_window_path` change token, from metadata only. */
  async function fence(path: string): Promise<{ size: number; changeToken: string }> {
    const metadata = await stat(path, { bigint: true }).catch(error => {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' ? fail('file_not_found') : fail('file_unavailable');
    });
    if (!metadata.isFile()) fail('file_not_file');
    return { size: Number(metadata.size), changeToken: fileChangeToken(metadata) };
  }

  async function openResolved(owner: string, path: string): Promise<RequestResult<'filesystem.sheet.open'>> {
    const format = sheetFormat(path) ?? fail('unsupported_document');
    const checked = await fence(path);
    if (checked.size > SHEET_MAX_BYTES) fail('file_too_large');
    const id = newHandleId();
    makeRoom(id);
    const handle: Handle = {
      owner, path, format, size: checked.size, changeToken: checked.changeToken, sheets: [],
      starting: true, loading: new Set(), loaded: new Set(), failures: new Map(), lastUsed: now(),
    };
    handles.set(id, handle);
    try {
      await startReader(handle);
    } catch (error) {
      handles.delete(id);
      throw error;
    }
    handle.starting = false;
    return { handle: id, size: handle.size, changeToken: handle.changeToken, sheets: handle.sheets };
  }

  function ownedHandle(id: string, owner: string): Handle {
    const handle = handles.get(id)?.owner === owner ? handles.get(id) : undefined;
    return handle ?? fail('sheet_not_found');
  }

  async function rows(owner: string, params: {
    handle: string; sheet: number; start: number; count: number; columnStart?: number; columnCount?: number;
  }): Promise<SheetRows> {
    const handle = ownedHandle(params.handle, owner);
    handle.lastUsed = now();
    // Ownership, then the change fence, both before the reader is asked anything.
    const checked = await fence(handle.path).catch(error => {
      const code = sheetCode(error);
      return code === 'file_not_found' ? fail('file_changed') : fail(code);
    });
    if (checked.size !== handle.size || checked.changeToken !== handle.changeToken) {
      const stale = handle.reader;
      handles.delete(params.handle);
      if (stale) endReader(handle, stale);
      fail('file_changed');
    }
    if (handle.startFailed) {
      const code = handle.startFailed;
      handle.startFailed = undefined;
      fail(code);
    }
    if (handle.starting) return loadingReply(params.start, params.columnStart ?? 0);
    const failure = handle.failures.get(params.sheet);
    if (failure) fail(failure);
    // While any sheet loads, every window answers `loading`: the reader is one process and a
    // load blocks it (design.md §3.1 — no request waits for a load).
    if (handle.loading.size > 0) return loadingReply(params.start, params.columnStart ?? 0);
    const link = handle.reader;
    if (!link) {
      restart(handle);
      return loadingReply(params.start, params.columnStart ?? 0);
    }
    const loaded = handle.loaded.has(params.sheet);
    if (!loaded) handle.loading.add(params.sheet);
    const id = ++requestIds;
    const answer = waitFor(link, message => message.t === 'rows' && message.id === id);
    link.process.post({
      t: 'rows', id,
      request: {
        sheet: params.sheet, start: params.start, count: params.count,
        columnStart: params.columnStart ?? 0, columnCount: params.columnCount ?? 200,
      },
    });
    const message = await answer.catch((error: unknown) => {
      handle.loading.delete(params.sheet);
      const code = sheetCode(error);
      // A crash or a memory stop is an error for this handle only; the next `rows` starts a
      // fresh reader (design.md §3.5).
      if (code === 'sheet_worker_failed' || code === 'sheet_out_of_memory') endReader(handle, link);
      return fail(code);
    });
    if (message.t !== 'rows') {
      handle.loading.delete(params.sheet);
      return fail('sheet_worker_failed');
    }
    if (!message.reply.ok) {
      handle.loading.delete(params.sheet);
      if (message.reply.code === 'sheet_worker_failed' || message.reply.code === 'sheet_out_of_memory') endReader(handle, link);
      return fail(message.reply.code);
    }
    const result: ReaderSheetRows = message.reply.result;
    if (result.state === 'ready') {
      handle.loaded.add(params.sheet);
      handle.loading.delete(params.sheet);
    }
    return result as SheetRows;
  }

  function close(owner: string, params: { handle: string }): null {
    const handle = handles.get(params.handle);
    if (handle && handle.owner === owner) {
      handles.delete(params.handle);
      const link = handle.reader;
      if (link) endReader(handle, link);
    }
    return null;
  }

  function sweep(): void {
    const at = now();
    for (const [id, handle] of [...handles.entries()]) {
      if (at - handle.lastUsed >= SHEET_HANDLE_FORGET_MS) {
        handles.delete(id);
        if (handle.reader) endReader(handle, handle.reader);
        continue;
      }
      if (handle.reader && handle.loading.size === 0 && at - handle.lastUsed >= SHEET_IDLE_MS) {
        endReader(handle, handle.reader);
      }
    }
  }

  const host: SheetHost = {
    async request(method, params, owner) {
      switch (method) {
        case 'filesystem.sheet.open': {
          const scope = params as FileScope & { path: string };
          const root = await options.workspaceRoot(scope);
          return await openResolved(owner, await containedExisting(root, scope.path)) as RequestResult<SheetMethod>;
        }
        case 'filesystem.external.sheet.open':
          return await openResolved(owner, await options.externalPath((params as { id: string }).id)) as RequestResult<SheetMethod>;
        case 'filesystem.sheet.rows':
          return await rows(owner, params as {
            handle: string; sheet: number; start: number; count: number; columnStart?: number; columnCount?: number;
          }) as RequestResult<SheetMethod>;
        case 'filesystem.sheet.close':
          return close(owner, params as { handle: string }) as RequestResult<SheetMethod>;
        default:
          return fail('invalid_request');
      }
    },
    reset() {
      endAll();
      handles.clear();
    },
    releaseOwner(owner) {
      for (const [id, handle] of [...handles.entries()]) {
        if (handle.owner !== owner) continue;
        handles.delete(id);
        if (handle.reader) endReader(handle, handle.reader);
      }
    },
    snapshot() {
      let readers = 0;
      for (const handle of handles.values()) if (handle.reader) readers += 1;
      return { handles: handles.size, readers, owners: [...handles.values()].map(handle => handle.owner) };
    },
  };
  return host;
}
