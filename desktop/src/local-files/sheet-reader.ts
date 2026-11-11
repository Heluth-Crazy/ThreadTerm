/**
 * The sheet reader process (`design.md` §3.4): an Electron `utilityProcess`, so it is
 * ThreadTerm.exe — no other executable runs, under Local file access = main.
 *
 * It opens **no files**: the main process reads the workbook inside ThreadTerm.exe and sends
 * it in 1 MiB chunks with a one-chunk credit window; this process feeds them to the
 * WebAssembly sheet core and answers `rows` requests. The workbook bytes live only in
 * ThreadTerm.exe processes' memory and are never written to disk (R22).
 *
 * Built to `desktop-dist/sheet-reader.cjs` by `npm run build:desktop`; the module it loads is
 * `desktop-dist/sheet-core.wasm`, passed as `THREADTERM_SHEET_WASM`.
 */
import { readFileSync } from 'node:fs';
import { createReaderSession } from './sheet-reader-core.js';
import type { ReaderCommand, ReaderMessage, SheetReaderSession } from './sheet-reader-core.js';
import { createSheetEngine, loadSheetWasm } from './sheet-wasm.js';

type ParentPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};

const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parent) throw new Error('the sheet reader runs as an Electron utility process');

const post = (message: ReaderMessage) => parent.postMessage(message);
const footprint = () => ({ rss: process.memoryUsage().rss, peak: process.resourceUsage().maxRSS * 1024 });

function fail(code: string): never {
  post({ t: 'failed', code });
  // Nothing else can run in this process: the module is the workbook.
  process.exit(1);
  throw new Error(code);
}

async function init(): Promise<SheetReaderSession> {
  const path = process.env.THREADTERM_SHEET_WASM;
  if (!path) fail('sheet_worker_failed');
  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch { fail('sheet_worker_failed'); }
  let module;
  try { module = await loadSheetWasm(bytes); }
  catch { fail('sheet_worker_failed'); }
  const session = createReaderSession(createSheetEngine(module), post, run => setImmediate(run), footprint);
  post({ t: 'ready' });
  return session;
}

// Commands are served one at a time, in order: loading the module is asynchronous and a sheet
// load blocks the event loop, so a queue is what keeps every reply attributable.
const ready = init();
let queue: Promise<void> = Promise.resolve();

parent.on('message', event => {
  const command = event.data as ReaderCommand;
  queue = queue.then(async () => {
    const session = await ready;
    switch (command.t) {
      case 'feed': session.feed(command.chunk); break;
      case 'open': session.open(command.format); break;
      case 'rows': session.rows(command.id, command.request); break;
      case 'memory': session.memory(); break;
      default: break;
    }
  }).catch(() => fail('sheet_worker_failed'));
});

ready.catch(() => fail('sheet_worker_failed'));
