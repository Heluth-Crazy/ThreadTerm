// Isolated runtime responsiveness QA for the usage-ledger scanner. It never opens
// Electron, a browser, a real provider, or the user's ThreadTerm profile.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPeer } from './pipe-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const qaRoot = resolve(root, '..', 'tt-qa-temp');
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const scratch = await mkdtemp(join(qaRoot, 'usage-ledger-responsiveness-'));
const resolvedQaRoot = qaRoot.toLowerCase();
assert.ok(scratch.toLowerCase().startsWith(`${resolvedQaRoot}\\`), 'scratch remains under the approved QA root');
assert.ok(existsSync(runtime), `QA runtime is missing: ${runtime}`);

const pipe = `\\\\.\\pipe\\tt-usage-ledger-qa-${randomUUID()}`;
const fixture = join(scratch, 'fixture');
const bin = join(scratch, 'bin');
const report = { passed: false, checks: [], timingsMs: [], progress: [], error: undefined };
let runtimeProcess;
let peer;
let scanId;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const timed = async (label, action) => {
  const started = performance.now();
  const value = await action();
  const ms = performance.now() - started;
  report.timingsMs.push({ label, ms });
  assert.ok(ms <= 150, `${label} blocked for ${ms.toFixed(1)} ms`);
  return value;
};
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };

function environment() {
  const blocked = /^(path|temp|tmp|home|userprofile|codex_home|threadterm_v3_data|threadterm_v3_user_data|threadterm_v3_pipe|claude_config_dir|kimi_code_home|grok_home|pi_coding_agent_dir|pi_coding_agent_session_dir|xdg_data_home|gemini_cli_home)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.test(key)));
  const home = join(scratch, 'home');
  Object.assign(env, {
    TEMP: qaRoot,
    TMP: qaRoot,
    PATH: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    HOME: home,
    USERPROFILE: home,
    THREADTERM_V3_DATA: join(scratch, 'data'),
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: pipe,
    CODEX_HOME: join(fixture, 'codex'),
    CLAUDE_CONFIG_DIR: join(fixture, 'claude'),
    KIMI_CODE_HOME: join(fixture, 'kimi'),
    GROK_HOME: join(fixture, 'grok'),
    PI_CODING_AGENT_DIR: join(fixture, 'pi'),
    PI_CODING_AGENT_SESSION_DIR: join(fixture, 'pi', 'sessions'),
    XDG_DATA_HOME: join(fixture, 'xdg'),
    GEMINI_CLI_HOME: home,
  });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1, 'PATH isolation keeps exactly one spelling');
  return env;
}

async function writeFixtures() {
  const sessionDir = join(fixture, 'codex', 'sessions', '2026', '10', '24');
  await mkdir(sessionDir, { recursive: true });
  await mkdir(bin, { recursive: true });
  for (const command of ['codex', 'claude', 'kimi', 'grok', 'pi', 'opencode', 'gemini']) {
    await writeFile(join(bin, `${command}.cmd`), '@echo off\r\nexit /b 127\r\n');
  }
  for (let index = 0; index < 25; index++) {
    const thread = `fixture-thread-${index}`;
    const record = Buffer.from(`${JSON.stringify({ type: 'session_meta', timestamp: '2026-10-24T00:00:00.000Z', payload: { id: thread } })}\n${JSON.stringify({ type: 'token_usage_record', timestamp: '2026-10-24T00:00:01.000Z', payload: { thread_id: thread, turn_id: `fixture-turn-${index}`, response_id: `fixture-response-${index}`, model: 'gpt-4.1-mini', usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 1 } } })}\n`);
    // Synthetic padding deliberately contains no prompt/reply/tool data. It is
    // just over the reader's bounded line threshold and must never be stored.
    const padding = Buffer.alloc(8 * 1024 * 1024, 0x78);
    await writeFile(join(sessionDir, `fixture-${String(index).padStart(2, '0')}.jsonl`), Buffer.concat([record, padding, Buffer.from('\n')]));
  }
  for (const path of ['claude/projects', 'kimi/sessions', 'grok/sessions', 'pi/sessions', 'xdg/opencode']) {
    await mkdir(join(fixture, path), { recursive: true });
  }
  check('created 25 synthetic 8 MiB Codex history files and fake provider executables under the isolated fixture root');
}

async function connectRuntime() {
  runtimeProcess = spawn(runtime, [], { env: environment(), windowsHide: true, stdio: 'ignore' });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (runtimeProcess.exitCode !== null) throw Error(`isolated runtime exited with ${runtimeProcess.exitCode}`);
    try {
      peer = await connectPeer(`${pipe}-control`);
      await peer.auth((await readFile(join(scratch, 'data', 'runtime.credential'), 'utf8')).trim());
      return;
    } catch {
      peer?.close(); peer = undefined;
      await sleep(100);
    }
  }
  throw Error('isolated runtime control pipe did not start');
}

async function awaitTerminal(scanId) {
  const deadline = Date.now() + 180_000;
  let mutationDone = false;
  while (Date.now() < deadline) {
    await timed('runtime.health during scan', () => peer.request('runtime.health', {}));
    if (!mutationDone) {
      const settings = await timed('usage.ledger.settings during scan', () => peer.request('usage.ledger.settings', {}));
      await timed('usage.ledger.settings.update during scan', () => peer.request('usage.ledger.settings.update', {
        operationId: randomUUID(), expectedRevision: settings.revision, value: { weekStart: 'monday' },
      }));
      mutationDone = true;
    }
    const event = await peer.nextEvent(value => value.event === 'usage.ledger.progress' && value.data?.scanId === scanId, 5_000);
    report.progress.push(event.data);
    if (event.data?.state !== 'running') return event.data;
  }
  throw Error('usage ledger scan did not reach a terminal event');
}

async function shutdown() {
  if (scanId && peer) {
    await peer.request('usage.ledger.cancel', { scanId, operationId: randomUUID() }).catch(() => {});
  }
  await peer?.request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  peer?.close(); peer = undefined;
  if (runtimeProcess && runtimeProcess.exitCode === null) {
    const exited = await Promise.race([
      new Promise(resolve => runtimeProcess.once('exit', () => resolve(true))),
      sleep(10_000).then(() => false),
    ]);
    if (!exited && runtimeProcess.exitCode === null) runtimeProcess.kill();
  }
  runtimeProcess = undefined;
}

try {
  await writeFixtures();
  await connectRuntime();
  const started = await peer.request('usage.ledger.refresh', { operationId: randomUUID() });
  scanId = started.scanId;
  assert.equal(started.state, 'running', 'fixture refresh starts a worker');
  const terminal = await awaitTerminal(started.scanId);
  assert.equal(terminal.state, 'completed', 'fixture scan completes');
  scanId = undefined;
  const reads = report.progress.filter(value => value.provider === 'codex').map(value => value.stats?.filesRead).filter(Number.isInteger);
  assert.ok(reads.length >= 25, `progress is emitted per file (${reads.length}/25)`);
  assert.ok(reads.every((value, index) => index === 0 || value >= reads[index - 1]), 'progress file counts are monotonic');
  const summary = await peer.request('usage.ledger.summary', {});
  assert.ok(summary.requests >= 25, `synthetic typed usage facts persisted (${summary.requests})`);
  check('runtime health and isolated settings mutation stayed within 150 ms while scanning');
  check('usage ledger progress was emitted at least once per synthetic Codex source file and wrote typed facts');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await shutdown().catch(error => { report.error ??= String(error); process.exitCode = 1; });
  await writeFile(join(scratch, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  assert.ok(scratch.toLowerCase().startsWith(`${resolvedQaRoot}\\`), 'cleanup target remains inside the approved QA root');
  await rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}
