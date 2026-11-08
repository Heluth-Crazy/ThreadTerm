// A deliberately small host-side TUI fixture for the mobile WebView smoke.
// Launch under a PTY.  `--log path` records exactly what the host saw; the
// mobile harness can then assert one banner, no SIGWINCH from keyboard toggles,
// ANSI colour bytes, and a raw CR from Return.
import {appendFile, readFile} from 'node:fs/promises';

const args = process.argv.slice(2);
const logIndex = args.indexOf('--log');
const logPath = logIndex < 0 ? undefined : args[logIndex + 1];
if (logIndex >= 0 && (!logPath || args.length !== 2)) {
  throw new Error('usage: node tui-host-fixture.mjs [--log <absolute-jsonl-path>]');
}

const now = () => new Date().toISOString();
async function record(event, data = {}) {
  if (!logPath) return;
  await appendFile(logPath, `${JSON.stringify({at: now(), event, ...data})}\n`, 'utf8');
}

let redraws = 0;
async function render(reason) {
  redraws += 1;
  await record('render', {reason, redraws, columns: process.stdout.columns, rows: process.stdout.rows});
  // Clear/home gives xterm a real full-screen redraw; colour checks use these
  // SGR bytes rather than a terminal implementation's derived styles.
  process.stdout.write(`\x1b[2J\x1b[H\x1b[1;36mOpenAI Codex (v0.167.0)\x1b[0m\r\n`);
  process.stdout.write(`\x1b[32mfixture redraw ${redraws}: ${reason}\x1b[0m\r\n`);
  process.stdout.write('\x1b[1;35mfixture> \x1b[0m');
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.on('SIGWINCH', () => { void render('SIGWINCH'); });
process.stdin.on('data', bytes => {
  void record('stdin', {base64: Buffer.from(bytes).toString('base64'), hex: Buffer.from(bytes).toString('hex')});
  // Keep the prompt's terminal semantics simple while retaining the exact raw
  // bytes in the receipt.  CR is the only submit delimiter for this fixture.
  if (bytes.includes(0x0d)) {
    process.stdout.write('\r\n\x1b[33mreceived CR\x1b[0m\r\n\x1b[1;35mfixture> \x1b[0m');
  }
});
process.stdin.resume();
await record('start', {pid: process.pid});
await render('start');

// Optional self-check used by simple process harnesses: pass a log that already
// exists only to append; never mutate or inspect unrelated paths at runtime.
if (logPath) await readFile(logPath, 'utf8').catch(() => '');
