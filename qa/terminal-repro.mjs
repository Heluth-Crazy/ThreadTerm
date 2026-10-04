// Stage 1 of task 10-03-windows-terminal-hardening: reproduce Windows terminal behaviour on the in-box
// ConPTY and on the pinned OpenConsole pair, with the target-qa runtime (isolated data and pipe) and
// the user's installed Claude / Codex CLIs. One mode per run; the machine is small.
//   node qa/terminal-repro.mjs input   <inbox|openconsole> <claude|codex>
//   node qa/terminal-repro.mjs resize  <inbox|openconsole> <claude|codex>
//   node qa/terminal-repro.mjs startup <inbox|openconsole>
//   node qa/terminal-repro.mjs da1     <inbox|openconsole>   (does a late DA1 reply reach the shell?)
// Both run runtime/target-qa/debug; `openconsole` sets THREADTERM_V3_CONPTY=bundled, which loads the
// verified pair from runtime/target-qa/debug/conpty/ (runtime/conpty/prepare.mjs) by absolute path.
// CLIs run in a folder both already trust, so no trust prompt is ever answered (that would edit the
// user's global config). Typed text is harmless if submitted. Afterwards only the transcripts/threads
// of these sessions are removed (Claude by its pre-assigned id, Codex by the ids the runtime saw);
// other new threads in that folder are listed, never deleted. Results: qa/results/terminal-repro/.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import xterm from '@xterm/xterm';
import { connectPeer } from './pipe-client.mjs';
import { removeAgentHistory } from './agent-history.mjs';
const { Terminal } = xterm;

const [mode, backend, agent] = process.argv.slice(2);
// kimi / grok / opencode: `--look` only until their composer is known (READY below) — never type into an
// unknown screen.
if (!['input', 'resize', 'startup', 'da1', 'reflow', 'pwsh', 'ctrlc', 'env'].includes(mode) || !['inbox', 'openconsole'].includes(backend) || (!['startup', 'da1', 'reflow', 'pwsh', 'ctrlc', 'env'].includes(mode) &&!['claude', 'codex', 'kimi', 'grok', 'opencode'].includes(agent))) {
  throw Error('usage: node qa/terminal-repro.mjs <input|resize> <inbox|openconsole> <claude|codex> | startup <inbox|openconsole>');
}
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const exeDir = join(root, 'runtime/target-qa/debug');
const exe = join(exeDir, 'threadterm-v3-runtime.exe');
assert.ok(existsSync(exe), `missing ${exe}`);
assert.ok(!existsSync(join(exeDir, 'conpty.dll')), 'no conpty.dll may sit beside the runtime (bare-name load)');
if (backend === 'openconsole') assert.ok(existsSync(join(exeDir, 'conpty', 'conpty.dll')) && existsSync(join(exeDir, 'conpty', 'OpenConsole.exe')), 'run runtime/conpty/prepare.mjs --out runtime/target-qa/debug/conpty first');
const TRUSTED_CWD = 'D:/project/ThreadTerm/ThreadTerm';
const delay = ms => new Promise(done => setTimeout(done, ms));
const startedAt = Date.now();
const log = text => console.log(`  … [${Math.round((Date.now() - startedAt) / 1000)}s] ${text}`);
const scratch = await mkdtemp(join(tmpdir(), 'tt-term-repro-'));
const data = join(scratch, 'data');
const pipe = `\\\\.\\pipe\\tt-term-repro-${randomUUID()}`;
const peers = new Set();
const sessions = [];
let daemon, runtimeEnv;

/**
 * Concurrent requests on one connection, routed by id like the desktop's runtime client
 * (`Peer.request` reads frames in order and drops other ids, so it is one-at-a-time only).
 */
function multiplex(peer) {
  const pending = new Map();
  (async () => {
    for (;;) {
      let frame;
      try { frame = await peer.next(24 * 3600 * 1000); } catch (error) { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); return; }
      const message = JSON.parse(frame);
      if (peer.captureEvent(message)) continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(Object.assign(Error(message.error.message), { code: message.error.code }));
      else waiter.resolve(message.result);
    }
  })();
  return (method, params = {}, timeoutMs = 60000) => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    peer.json({ v: 1, id, method, params });
  });
}

async function start() {
  mkdirSync(data, { recursive: true });
  // The desktop starts the runtime outside any Claude Code session; inherited markers would make the
  // Claude CLI in these terminals turn transcript saving off (seen in the first run).
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT)/.test(key)));
  // Detached like desktop/src/runtime-client.ts: a new process group, which ignores Ctrl+C (inherited).
  runtimeEnv = { ...env, ...(mode === 'env' ? launcherEnv : {}), THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(scratch, 'user'), THREADTERM_V3_PIPE: pipe, THREADTERM_V3_CONPTY: backend === 'openconsole' ? 'bundled' : 'system' };
  daemon = spawn(exe, [], { detached: true, windowsHide: true, env: runtimeEnv, stdio: 'ignore' });
  for (let i = 0; i < 150; i++) {
    try {
      const peer = await connectPeer(`${pipe}-control`);
      await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      peer.request = multiplex(peer);
      peers.add(peer);
      return peer;
    } catch { if (daemon.exitCode !== null) throw Error('daemon exited at startup'); await delay(100); }
  }
  throw Error('runtime startup timeout');
}

const mirrors = new Set();
/** Reads a session's output incrementally into a mirror xterm, as a ThreadTerm window would. */
function mirror(peer, id, cols, rows) {
  // TerminalSurface passes the Windows build as xterm's `windowsPty` (19045 here → reflow off);
  // TT_WINDOWS_PTY=<build> mirrors that, unset leaves xterm's defaults.
  const build = Number(process.env.TT_WINDOWS_PTY);
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true, ...(build > 0 ? { windowsPty: { backend: 'conpty', buildNumber: build } } : {}) });
  let cursor = 0, stopped = false, bytes = 0;
  const handle = { stop: () => { stopped = true; } };
  mirrors.add(handle);
  const pump = (async () => {
    while (!stopped) {
      const page = await peer.request('terminal.read', { sessionId: id, cursor, limit: 1048576 }).catch(() => undefined);
      if (page && page.nextCursor > cursor) {
        const chunk = Buffer.from(page.data, 'base64');
        bytes += chunk.length;
        await new Promise(done => term.write(chunk, done));
        cursor = page.nextCursor;
      } else await delay(40);
    }
  })();
  const lines = (from, to) => Array.from({ length: to - from }, (_, row) => term.buffer.active.getLine(from + row)?.translateToString(true) ?? '');
  return {
    term,
    get bytes() { return bytes; },
    screen: () => lines(term.buffer.active.baseY, term.buffer.active.baseY + term.rows),
    all: () => lines(0, term.buffer.active.length),
    stop: async () => { stopped = true; mirrors.delete(handle); await pump; term.dispose(); },
  };
}

async function withLease(peer, id, action) {
  const { leaseEpoch } = await peer.request('session.claim', { sessionId: id, clientId: 'qa-terminal-repro' });
  try { return await action(leaseEpoch); } finally { await peer.request('session.release', { sessionId: id, leaseEpoch }).catch(() => {}); }
}

async function waitFor(check, message, ms = 60000, every = 250) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(every); }
  throw Error(message);
}

// The CLI's own composer, not a menu: a 2026-10-03 run typed into Codex's "Update available"
// menu (where "1. Update now" is preselected) and started its updater.
const READY = { claude: /for shortcuts|❯/i, codex: /context left|for shortcuts|Ask Codex/i };
const TRUST = /trust the (files|contents)|Do you trust|信任/i;
const UPDATE_MENU = /Update available|Update now|Skip until next version/i;

async function openCli(peer, cols, rows) {
  // --scratch-cwd: a throwaway folder (history removable by folder name; a CLI may show a trust prompt — never answered).
  const cwd = process.argv.includes('--scratch-cwd') ? join(scratch, `${basename(scratch)}-ws`) : TRUSTED_CWD;
  mkdirSync(cwd, { recursive: true });
  const created = await peer.request('session.create', { cwd, title: `QA repro ${agent}`, provider: agent, mode: 'terminal', operationId: randomUUID() }, 120000);
  sessions.push(created);
  const view = mirror(peer, created.id, cols, rows);
  await withLease(peer, created.id, epoch => peer.request('terminal.resize', { sessionId: created.id, cols, rows, leaseEpoch: epoch }));
  let skippedUpdate = false;
  await waitFor(async () => {
    const text = view.screen().join('\n');
    if (TRUST.test(text)) throw Error('a trust prompt appeared; this script never answers it');
    if (UPDATE_MENU.test(text)) {
      if (skippedUpdate) return false;
      // "esc skip": skips this run only (not "Skip until next version", which persists).
      await withLease(peer, created.id, epoch => peer.request('terminal.input', { sessionId: created.id, data: '\x1b', leaseEpoch: epoch }));
      skippedUpdate = true;
      log('skipped the CLI update menu with Esc (this run only)');
      return false;
    }
    if (!READY[agent]) {
      if (!process.argv.includes('--look')) throw Error(`no known composer for ${agent}; inspect it with --look first`);
      return view.bytes > 200; // look only: any first paint
    }
    return READY[agent].test(text);
  }, `${agent} did not render its input`, 90000);
  if (UPDATE_MENU.test(view.screen().join('\n')) || TRUST.test(view.screen().join('\n'))) throw Error('a menu is still on screen; refusing to type');
  // Let the TUI finish its first paint.
  let last = -1;
  await waitFor(async () => { const now = view.bytes; const quiet = now === last; last = now; await delay(400); return quiet; }, 'output did not settle', 20000);
  return { session: created, view };
}

// ---------- input: which encoding of Shift+Enter gives a newline? ----------
const ENCODINGS = {
  // xterm.js 6 sends CR for Enter, Shift+Enter and Ctrl+Enter alike (source) — that is Enter, so it submits; not sent here.
  lf: '\n',
  'esc-cr': '\x1b\r', // what xterm already sends for Alt+Enter
  'csi-u': '\x1b[13;2u', // kitty keyboard protocol Shift+Enter (Claude pushes the protocol)
  win32: '\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_', // win32-input-mode record: VK_RETURN, scan 0x1C, CR, down/up, SHIFT_PRESSED
};
const LINE1 = 'Reply with only OK';
const LINE2 = 'and do nothing else';

function submitted(session) {
  if (agent === 'claude') {
    const id = session.nativeId;
    const file = join(homedir(), '.claude', 'projects', 'D--project-ThreadTerm-ThreadTerm', `${id}.jsonl`);
    return existsSync(file) && statSync(file).size > 0 && (readFileSyncSafe(file).includes(LINE1));
  }
  return codexThreads().some(thread => sessions.some(item => item.nativeId === thread.id) && thread.has_user_event);
}
function readFileSyncSafe(path) { try { return readFileSync(path, 'utf8'); } catch { return ''; } }

async function inputMode(peer) {
  const results = {};
  for (const [name, bytes] of Object.entries(ENCODINGS)) {
    const { session, view } = await openCli(peer, 100, 30);
    await withLease(peer, session.id, async epoch => {
      await peer.request('terminal.input', { sessionId: session.id, data: LINE1, leaseEpoch: epoch });
      await delay(500);
      await peer.request('terminal.input', { sessionId: session.id, data: bytes, leaseEpoch: epoch });
      await delay(500);
      await peer.request('terminal.input', { sessionId: session.id, data: LINE2, leaseEpoch: epoch });
    });
    await delay(2500);
    const screen = view.screen();
    const row1 = screen.findIndex(line => line.includes(LINE1));
    const row2 = screen.findIndex(line => line.includes(LINE2));
    const snapshot = (await peer.request('runtime.snapshot')).sessions.find(item => item.id === session.id);
    session.nativeId = snapshot?.nativeId ?? session.nativeId;
    const garbage = screen.some(line => /\[13;2u|13;28;13|\^\[/.test(line));
    const verdict = submitted(session) ? 'submitted'
      : garbage ? 'garbage'
      : row1 >= 0 && row2 > row1 ? 'newline'
      : row1 >= 0 && row1 === row2 ? 'same line'
      : 'unclear';
    results[name] = { verdict, row1, row2, screen: screen.filter(line => line.trim()).slice(-12) };
    log(`${name}: ${verdict} (rows ${row1}/${row2})`);
    await view.stop();
    await peer.request('session.stop', { sessionId: session.id, force: true, operationId: randomUUID() }).catch(() => {});
    await delay(800);
  }
  return results;
}

// ---------- resize: does a divider drag leave artifacts, and does coalescing help? ----------
const CHROME = { claude: /for shortcuts|bypass permissions|accept edits/i, codex: /context left|⏎ send|send ⏎/i };
async function resizeMode(peer) {
  const steps = [...Array.from({ length: 26 }, (_, i) => 120 - i * 2), ...Array.from({ length: 20 }, (_, i) => 72 + i * 2)];
  const results = {};
  // `scheduler-N`: the renderer's own createResizeScheduler (renderer/src/terminalResize.ts) with minIntervalMs N;
  // `quiet-Q[-M]`: the same with quietMs Q (and maxWaitMs M).
  const variants = (process.env.TT_RESIZE_VARIANTS ?? 'every-step,coalesced,scheduler-0,scheduler-100,scheduler-250').split(',');
  const { createResizeScheduler } = await import('../renderer/src/terminalResize.ts');
  for (const variant of variants) {
    const { session, view } = await openCli(peer, 120, 30);
    const before = view.screen().filter(line => CHROME[agent].test(line)).length;
    let requests = 0;
    await withLease(peer, session.id, async epoch => {
      const sent = [];
      const resizePty = cols => { requests++; return peer.request('terminal.resize', { sessionId: session.id, cols, rows: 30, leaseEpoch: epoch }); };
      const [kind, first, second] = variant.split('-');
      const scheduler = kind === 'scheduler' ? createResizeScheduler(size => resizePty(size.cols), { minIntervalMs: Number(first) })
        : kind === 'quiet' ? createResizeScheduler(size => resizePty(size.cols), { quietMs: Number(first), ...(second ? { maxWaitMs: Number(second) } : {}) })
        : undefined;
      for (const cols of steps) {
        view.term.resize(cols, 30); // xterm reflows at once, like TerminalSurface's fit()
        if (variant === 'every-step') sent.push(resizePty(cols).catch(() => {}));
        scheduler?.request({ cols, rows: 30, epoch });
        await delay(40);
      }
      if (variant === 'coalesced') await resizePty(steps.at(-1));
      await Promise.all(sent);
      if (scheduler) { await delay(1000); scheduler.dispose(); }
    });
    await delay(3000);
    const screen = view.screen();
    const all = view.all();
    const chrome = screen.filter(line => CHROME[agent].test(line)).length;
    const scrollbackChrome = all.filter(line => CHROME[agent].test(line)).length;
    const scrollback = all.slice(0, Math.max(0, all.length - 30));
    results[variant] = { requests, finalCols: view.term.cols, chromeBefore: before, chromeOnScreen: chrome, chromeInBuffer: scrollbackChrome, bufferLines: all.length, scrollbackNonEmpty: scrollback.filter(line => line.trim()).length, scrollback: scrollback.filter(line => line.trim()).slice(0, 80), screen: screen.filter(line => line.trim()) };
    log(`${variant}: ${results[variant].requests} resize request(s); status/footer lines on screen ${before} → ${chrome}; in whole buffer ${scrollbackChrome}; buffer ${all.length} lines`);
    await view.stop();
    await peer.request('session.stop', { sessionId: session.id, force: true, operationId: randomUUID() }).catch(() => {});
    await delay(800);
  }
  return results;
}

// ---------- startup: time to first output and to a marker ----------
async function startupMode(peer) {
  const runs = [];
  for (let i = 0; i < 6; i++) {
    const marker = `READY-${randomUUID().slice(0, 6)}`;
    const t0 = Date.now();
    const created = await peer.request('session.create', { cwd: scratch, title: 'QA startup', provider: 'shell', mode: 'terminal', executable: 'cmd.exe', args: ['/d', '/c', `echo ${marker}`], operationId: randomUUID() }, 60000);
    sessions.push(created);
    const created_ms = Date.now() - t0;
    let first, done, raw = '';
    await waitFor(async () => {
      const page = await peer.request('terminal.read', { sessionId: created.id, cursor: 0, limit: 1048576 });
      raw = Buffer.from(page.data, 'base64').toString();
      if (raw.length && first === undefined) first = Date.now() - t0;
      if (raw.includes(marker)) { done = Date.now() - t0; return true; }
      return false;
    }, 'marker never appeared', 30000, 15);
    const da1 = /\x1b\[c|\x1b\[0c/.test(raw);
    runs.push({ created_ms, first_output_ms: first, marker_ms: done, da1_query_in_output: da1 });
    log(`run ${i + 1}: create ${created_ms} ms, first output ${first} ms, marker ${done} ms${da1 ? ', DA1 query seen' : ''}`);
    await delay(300);
  }
  const median = key => [...runs.map(run => run[key])].sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  return { runs, median_marker_ms: median('marker_ms'), median_first_output_ms: median('first_output_ms') };
}

// ---------- da1: does a late DA1 reply (what a live xterm sends back) reach the shell as typed text? ----------
async function da1Mode(peer) {
  const created = await peer.request('session.create', { cwd: scratch, title: 'QA da1', provider: 'shell', mode: 'terminal', executable: 'cmd.exe', args: ['/d', '/k', 'prompt READY$G'], operationId: randomUUID() }, 60000);
  sessions.push(created);
  const view = mirror(peer, created.id, 100, 20);
  await waitFor(() => view.all().some(line => line.includes('READY>')), 'cmd prompt did not appear', 30000);
  const raw = Buffer.from((await peer.request('terminal.read', { sessionId: created.id, cursor: 0, limit: 1048576 })).data, 'base64').toString();
  log(`startup output head: ${JSON.stringify(raw.slice(0, 160))}`);
  await withLease(peer, created.id, async epoch => {
    // A live xterm answers a DA1 query it sees in the output; reply only when one reached the client
    // (TT_FORCE_REPLY: always, to show what a late reply does).
    if (/\x1b\[0?c/.test(raw) || process.env.TT_FORCE_REPLY) await peer.request('terminal.input', { sessionId: created.id, data: '\x1b[?1;2c', leaseEpoch: epoch });
    await delay(400);
    await peer.request('terminal.input', { sessionId: created.id, data: 'echo DA1-PROBE\r', leaseEpoch: epoch });
  });
  await waitFor(() => view.all().some(line => line.includes('DA1-PROBE') && !line.includes('echo')), 'echo output did not appear', 15000)
    .catch(error => { console.log(view.all().filter(line => line.trim()).slice(-8).map(line => `    | ${line}`).join('\n')); throw error; });
  const lines = view.all().filter(line => line.trim());
  const commandLine = lines.find(line => line.includes('echo DA1-PROBE')) ?? '';
  const stray = /\[\?1;2c|\^\[|1;2c/.test(commandLine);
  // Which console hosts are running right now, and from where (the bundled one must come from <runtime>/conpty/).
  const hosts = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='OpenConsole.exe'\" | ForEach-Object { $_.ExecutablePath }"], { encoding: 'utf8', windowsHide: true })
    .split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  log(`OpenConsole processes: ${hosts.length ? hosts.join(' | ') : 'none'}`);
  log(`DA1 query in startup output: ${/\x1b\[0?c/.test(raw)}; command line as typed: ${JSON.stringify(commandLine.trim())}; stray reply text: ${stray}`);
  await view.stop();
  await peer.request('session.stop', { sessionId: created.id, force: true, operationId: randomUUID() }).catch(() => {});
  return { openConsoleHosts: hosts, startupHadDa1Query: /\x1b\[0?c/.test(raw), commandLine: commandLine.trim(), strayReplyText: stray, screen: lines.slice(-8) };
}

// ---------- reflow: does a long line survive narrowing and widening again? ----------
async function reflowMode(peer) {
  const created = await peer.request('session.create', { cwd: scratch, title: 'QA reflow', provider: 'shell', mode: 'terminal', executable: 'cmd.exe', args: ['/d', '/k', 'prompt READY$G'], operationId: randomUUID() }, 60000);
  sessions.push(created);
  const view = mirror(peer, created.id, 120, 20);
  await waitFor(() => view.all().some(line => line.includes('READY>')), 'cmd prompt did not appear', 30000);
  const marker = Array.from({ length: 20 }, (_, index) => `W${String(index).padStart(2, '0')}-abcde`).join('');
  const logical = () => {
    const buffer = view.term.buffer.active, lines = [];
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (line?.isWrapped && lines.length) lines[lines.length - 1] += line.translateToString(true);
      else lines.push(line?.translateToString(true) ?? '');
    }
    return lines;
  };
  const result = {};
  await withLease(peer, created.id, async epoch => {
    // The app always sizes the PTY to its xterm first.
    await peer.request('terminal.resize', { sessionId: created.id, cols: 120, rows: 20, leaseEpoch: epoch });
    await delay(500);
    await peer.request('terminal.input', { sessionId: created.id, data: `echo ${marker}\r`, leaseEpoch: epoch });
    await waitFor(() => logical().some(line => line.trim() === marker), 'long line did not print', 15000).catch(error => {
      const buffer = view.term.buffer.active;
      for (let y = 0; y < buffer.length; y++) {
        const line = buffer.getLine(y);
        const text = line?.translateToString(true) ?? '';
        if (text.includes('W0') || text.includes('W1')) console.log(`    | row ${y} wrapped=${line.isWrapped} len=${text.length}: ${text.slice(0, 70)}…`);
      }
      throw error;
    });
    for (const cols of [60, 120]) {
      view.term.resize(cols, 20);
      await peer.request('terminal.resize', { sessionId: created.id, cols, rows: 20, leaseEpoch: epoch });
      await delay(1200);
      const lines = logical();
      const intact = lines.filter(line => line.trim() === marker).length;
      const fragments = lines.filter(line => line.includes('W1') && line.trim() !== marker && !line.includes('echo')).length;
      result[`after ${cols} cols`] = { intact, fragments };
      log(`after resize to ${cols}: intact copies of the 200-char line ${intact}, broken fragments ${fragments}`);
    }
    // A line that exactly fills the width and ends in a non-space (like a TUI border), then a normal line:
    // xterm's "non-space at the edge means wrapped" guess (windowsPty build < 21376) may glue the two together.
    const border = '='.repeat(120);
    await peer.request('terminal.input', { sessionId: created.id, data: 'cls\r', leaseEpoch: epoch });
    await delay(500);
    await peer.request('terminal.input', { sessionId: created.id, data: `echo ${border.slice(0, 120)}&echo NEXT-LINE\r`, leaseEpoch: epoch });
    await waitFor(() => logical().some(line => line.includes('NEXT-LINE') && !line.includes('echo')), 'border test did not print', 15000);
    for (const cols of [60, 120]) {
      view.term.resize(cols, 20);
      await peer.request('terminal.resize', { sessionId: created.id, cols, rows: 20, leaseEpoch: epoch });
      await delay(1200);
    }
    const glued = logical().some(line => line.includes('=====') && line.includes('NEXT-LINE') && !line.includes('echo'));
    result.borderGluedToNextLine = glued;
    log(`full-width border glued to the next line after 120→60→120: ${glued}`);
  });
  await view.stop();
  await peer.request('session.stop', { sessionId: created.id, force: true, operationId: randomUUID() }).catch(() => {});
  return result;
}

// ---------- ctrlc: does Ctrl+C interrupt a running cmd.exe command? ----------
async function ctrlcMode(peer) {
  const created = await peer.request('session.create', { cwd: scratch, title: 'QA ctrl-c', provider: 'shell', mode: 'terminal', executable: 'cmd.exe', args: ['/d', '/k', 'prompt READY$G'], operationId: randomUUID() }, 60000);
  sessions.push(created);
  const view = mirror(peer, created.id, 100, 24);
  const lines = () => view.all().filter(line => line.trim());
  await waitFor(() => lines().some(line => line.includes('READY>')), 'cmd prompt did not appear', 30000);
  let interrupted = false;
  await withLease(peer, created.id, async epoch => {
    const send = data => peer.request('terminal.input', { sessionId: created.id, data, leaseEpoch: epoch });
    await send('ping -n 30 127.0.0.1\r');
    await waitFor(() => lines().filter(line => /127\.0\.0\.1/.test(line)).length >= 3, 'ping did not start', 15000);
    await send('\x03');
    interrupted = await waitFor(() => lines().at(-1)?.trim() === 'READY>', 'prompt did not return', 5000).then(() => true, () => false);
  });
  log(`cmd: Ctrl+C interrupted ping: ${interrupted}`);
  if (!interrupted) console.log(lines().slice(-6).map(line => `    | ${line}`).join('\n'));
  await view.stop();
  await peer.request('session.stop', { sessionId: created.id, force: true, operationId: randomUUID() }).catch(() => {});
  return { interrupted };
}

// ---------- env: what a new terminal's environment is made of (runtime/src/environment.rs) ----------
// The runtime is started like a QA run that isolates a home: USERPROFILE and APPDATA point into the
// scratch folder, a launcher-only variable is set and a fake bin is put first on PATH. Read-only for the
// registry; the terminal writes `set` into the scratch folder.
const launcherEnv = { USERPROFILE: join(scratch, 'home'), APPDATA: join(scratch, 'appdata'), TT_ENV_PROBE: 'launcher', PATH: `${join(scratch, 'bin')};${process.env.PATH}` };
async function envMode(peer) {
  const file = join(scratch, 'env.txt');
  const created = await peer.request('session.create', { cwd: scratch, title: 'QA env', provider: 'shell', mode: 'terminal', executable: 'cmd.exe', args: ['/d', '/c', `set>${file}`], operationId: randomUUID() }, 60000);
  sessions.push(created);
  await waitFor(() => existsSync(file) && statSync(file).size > 0, 'the terminal did not write its environment', 30000);
  await delay(500);
  const vars = new Map(readFileSync(file, 'latin1').split(/\r?\n/).filter(Boolean).map(line => { const at = line.indexOf('=', 1); return [line.slice(0, at).toUpperCase(), line.slice(at + 1)]; }));
  const path = (vars.get('PATH') ?? '').split(';').filter(Boolean);
  const inScratch = value => value?.toLowerCase().startsWith(scratch.toLowerCase());
  const result = {
    count: vars.size,
    launcherOnlyKept: vars.get('TT_ENV_PROBE') === 'launcher',
    userprofileKept: vars.get('USERPROFILE') === launcherEnv.USERPROFILE,
    appdataKept: vars.get('APPDATA') === launcherEnv.APPDATA,
    temp: vars.get('TEMP'),
    tempIsReal: vars.get('TEMP') === process.env.TEMP && !inScratch(vars.get('TEMP')),
    pathEntriesInScratch: path.filter(inScratch),
    pathGitBashEntries: path.filter(entry => /\\Git\\(usr|mingw64)\\/i.test(entry)).length,
    logonServer: vars.has('LOGONSERVER'),
    bootstrapVarsLeft: [...vars.keys()].filter(name => name.startsWith('THREADTERM_V3_BOOTSTRAP')),
  };
  // Names only: what the terminal has that the runtime was not given, and the reverse.
  const given = new Set(Object.keys(runtimeEnv).map(name => name.toUpperCase()));
  result.notFromLauncher = [...vars.keys()].filter(name => !given.has(name)).sort();
  result.launcherDropped = [...given].filter(name => !vars.has(name)).sort();
  log(JSON.stringify(result));
  await peer.request('session.stop', { sessionId: created.id, force: true, operationId: randomUUID() }).catch(() => {});
  return result;
}

// ---------- pwsh: PowerShell soak (TT_SHELL=pwsh.exe | powershell.exe) ----------
async function pwshMode(peer) {
  const shell = process.env.TT_SHELL ?? 'pwsh.exe';
  const t0 = Date.now();
  const created = await peer.request('session.create', { cwd: scratch, title: 'QA pwsh', provider: 'shell', mode: 'terminal', executable: shell, args: ['-NoLogo', '-NoProfile'], operationId: randomUUID() }, 60000);
  const createMs = Date.now() - t0;
  sessions.push(created);
  const view = mirror(peer, created.id, 120, 24);
  const screenText = () => view.all().filter(line => line.trim()).join('\n');
  const has = (pattern, count = 1) => screenText().split('\n').filter(line => pattern.test(line)).length >= count;
  const result = { shell, createMs };
  await withLease(peer, created.id, async epoch => {
    const send = data => peer.request('terminal.input', { sessionId: created.id, data, leaseEpoch: epoch });
    await peer.request('terminal.resize', { sessionId: created.id, cols: 120, rows: 24, leaseEpoch: epoch });
    await waitFor(() => has(/^PS .*>/), 'PowerShell prompt did not appear', 30000);
    result.promptMs = Date.now() - t0;
    await send('Write-Output "PWSH-OK $((1..3) -join \',\')"\r');
    await waitFor(() => has(/^PWSH-OK 1,2,3\s*$/), 'typed command did not run', 15000);
    result.command = true;
    await send('\x1b[A'); // Up arrow: PSReadLine history
    await delay(400);
    await send('\r');
    await waitFor(() => has(/^PWSH-OK 1,2,3\s*$/, 2), 'Up-arrow history did not recall the command', 15000);
    result.history = true;
    await send('Start-Sleep -Seconds 20\r');
    await delay(1200);
    await send('\x03'); // Ctrl+C
    await delay(600);
    await send('Write-Output AFTER-CTRL-C\r');
    await waitFor(() => has(/^AFTER-CTRL-C\s*$/), 'Ctrl+C did not interrupt Start-Sleep', 10000)
      .catch(error => { console.log(screenText().split('\n').slice(-8).map(line => `    | ${line}`).join('\n')); throw error; });
    result.ctrlC = true;
    await send(`Clear-Host; Write-Output ('=' * 120); Write-Output NEXT-LINE\r`);
    await waitFor(() => has(/^NEXT-LINE\s*$/), 'border test did not print', 15000);
    for (const cols of [60, 120]) {
      view.term.resize(cols, 24);
      await peer.request('terminal.resize', { sessionId: created.id, cols, rows: 24, leaseEpoch: epoch });
      await delay(1200);
    }
    const buffer = view.term.buffer.active, logical = [];
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (line?.isWrapped && logical.length) logical[logical.length - 1] += line.translateToString(true);
      else logical.push(line?.translateToString(true) ?? '');
    }
    result.borderGlued = logical.some(line => line.includes('=====') && line.includes('NEXT-LINE') && !line.includes('Write-Output'));
  });
  result.strayReply = /\[\?1;2c|\[\?61c|\^\[\[/.test(screenText());
  log(`${shell}: create ${result.createMs} ms, prompt ${result.promptMs} ms; command ${result.command}; history ${result.history}; Ctrl+C ${result.ctrlC}; full-width line glued ${result.borderGlued}; stray reply ${result.strayReply}`);
  await view.stop();
  await peer.request('session.stop', { sessionId: created.id, force: true, operationId: randomUUID() }).catch(() => {});
  return result;
}

// ---------- cleanup of exactly these sessions' agent history ----------
function codexThreads() {
  const state = join(homedir(), '.codex', 'state_5.sqlite');
  if (!existsSync(state)) return [];
  const db = new DatabaseSync(state, { readOnly: true });
  try {
    return db.prepare("SELECT id, rollout_path, cwd, created_at_ms, has_user_event FROM threads WHERE created_at_ms >= ? AND replace(lower(cwd),'/','\\') = ?").all(startedAt - 5000, 'd:\\project\\threadterm\\threadterm');
  } finally { db.close(); }
}
function removeCodexThread(id, rollout) {
  const home = join(homedir(), '.codex');
  const run = (file, statements) => {
    const db = new DatabaseSync(join(home, file));
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try { for (const sql of statements) db.prepare(sql).run(id); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.close(); }
  };
  if (rollout && existsSync(rollout)) rmSync(rollout, { force: true });
  run('state_5.sqlite', ['DELETE FROM thread_dynamic_tools WHERE thread_id=?', 'DELETE FROM thread_attachments WHERE thread_id=?', 'DELETE FROM threads WHERE id=?']);
  if (existsSync(join(home, 'thread_history_1.sqlite'))) run('thread_history_1.sqlite', ['DELETE FROM thread_items WHERE thread_id=?', 'DELETE FROM thread_turns WHERE thread_id=?', 'DELETE FROM thread_history_projection_state WHERE thread_id=?']);
}
function cleanup() {
  const ids = new Set(sessions.map(session => session.nativeId).filter(Boolean));
  const removed = [], listed = [];
  const claude = join(homedir(), '.claude');
  for (const sub of ['projects/D--project-ThreadTerm-ThreadTerm', 'todos', 'file-history', 'session-env', 'shell-snapshots']) {
    const dir = join(claude, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) if ([...ids].some(id => name.includes(id))) { rmSync(join(dir, name), { recursive: true, force: true }); removed.push(`claude ${sub}/${name}`); }
  }
  for (const thread of codexThreads()) {
    if (ids.has(thread.id)) { removeCodexThread(thread.id, thread.rollout_path); removed.push(`codex thread ${thread.id}`); }
    else listed.push(`codex thread ${thread.id} (created during the run, not ours by id — left alone)`);
  }
  if (process.argv.includes('--scratch-cwd')) {
    // Everything that names this run's scratch folder: Claude/Codex/Kimi (agent-history.mjs) and Grok.
    const slug = basename(scratch).toLowerCase();
    const left = removeAgentHistory(slug);
    if (left.length) listed.push(...left.map(item => `left: ${item}`));
    const grokSessions = join(homedir(), '.grok', 'sessions');
    for (const name of existsSync(grokSessions) ? readdirSync(grokSessions) : []) {
      if (decodeURIComponent(name).toLowerCase().includes(slug)) { rmSync(join(grokSessions, name), { recursive: true, force: true }); removed.push(`grok sessions/${name}`); }
    }
    const active = join(homedir(), '.grok', 'active_sessions.json');
    if (existsSync(active)) {
      const entries = JSON.parse(readFileSync(active, 'utf8'));
      const kept = entries.filter(entry => !String(entry.cwd ?? '').toLowerCase().includes(slug));
      if (kept.length !== entries.length) { writeFileSync(active, `${JSON.stringify(kept, null, 2)}\n`); removed.push('grok active_sessions entry'); }
    }
  }
  return { removed, listed };
}

let failed, result;
try {
  const peer = await start();
  log(`runtime: ${backend} (${exeDir})`);
  if (process.argv.includes('--look')) {
    // Open the CLI (handling menus as above) and show its screen; nothing is typed.
    const { session, view } = await openCli(peer, 100, 30);
    result = { look: view.screen() };
    console.log(view.screen().filter(line => line.trim()).join('\n'));
    await view.stop();
    await peer.request('session.stop', { sessionId: session.id, force: true, operationId: randomUUID() }).catch(() => {});
  } else result = mode === 'input' ? await inputMode(peer) : mode === 'resize' ? await resizeMode(peer) : mode === 'da1' ? await da1Mode(peer) : mode === 'reflow' ? await reflowMode(peer) : mode === 'pwsh' ? await pwshMode(peer) : mode === 'ctrlc' ? await ctrlcMode(peer) : mode === 'env' ? await envMode(peer) : await startupMode(peer);
  // Final native ids (Codex learns its thread id after start).
  const snapshot = await peer.request('runtime.snapshot');
  for (const session of sessions) session.nativeId = snapshot.sessions.find(item => item.id === session.id)?.nativeId ?? session.nativeId;
} catch (error) {
  failed = error;
  console.log(`FAIL ${mode}: ${error.stack ?? error}`);
} finally {
  for (const handle of mirrors) handle.stop();
  if (daemon && daemon.exitCode === null) daemon.kill();
  for (const peer of peers) peer.close();
  await delay(6000);
  const history = cleanup();
  for (const line of history.removed) console.log(`removed ${line}`);
  for (const line of history.listed) console.log(`NOTE ${line}`);
  await rm(scratch, { recursive: true, force: true }).catch(() => console.log(`scratch left at ${scratch}`));
  const out = join(root, 'qa/results/terminal-repro');
  mkdirSync(out, { recursive: true });
  const file = join(out, `${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}-${backend}${agent ? `-${agent}` : ''}.json`);
  writeFileSync(file, `${JSON.stringify({ mode, backend, agent, failure: failed ? String(failed.message ?? failed) : null, result, history }, null, 2)}\n`);
  console.log(`result: ${file}`);
  process.exit(failed ? 1 : 0);
}
