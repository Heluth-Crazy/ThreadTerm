// Real runtime coverage for the Default shell setting. Uses only a Shell terminal;
// it never resolves or starts an agent CLI.
//
// Run after building the runtime:
//   Set THREADTERM_V3_RUNTIME_BIN to the built worktree runtime executable.
//   node qa/default-shell.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectPeer } from './pipe-client.mjs';
import { terminalText } from './lib/terminal-text.mjs';

const executable = process.env.THREADTERM_V3_RUNTIME_BIN;
assert.ok(executable, 'Set THREADTERM_V3_RUNTIME_BIN to the built worktree runtime executable');
const scratch = await mkdtemp(join(tmpdir(), 'tt-default-shell-'));
const data = join(scratch, 'data');
const project = join(scratch, 'project');
const providerBin = join(scratch, 'provider-bin');
const pipe = `\\\\.\\pipe\\tt-default-shell-${randomUUID()}`;
const peers = [];
let daemon;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function runtimeEnvironment() {
  const excluded = new Set(['path', 'threadterm_qa_provider_bin', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !excluded.has(key.toLowerCase())));
  return {
    ...env,
    PATH: [providerBin, join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    THREADTERM_QA_PROVIDER_BIN: providerBin,
    THREADTERM_V3_DATA: data,
    THREADTERM_V3_USER_DATA: join(scratch, 'user'),
    THREADTERM_V3_PIPE: pipe,
  };
}

function startDaemon() {
  daemon = spawn(executable, [], {
    windowsHide: true,
    env: runtimeEnvironment(),
    stdio: 'ignore',
  });
}

async function connect() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const peer = await connectPeer(`${pipe}-control`);
      await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      peers.push(peer);
      return peer;
    } catch (error) {
      if (daemon.exitCode !== null) throw Error(`runtime exited during startup (${daemon.exitCode})`);
      await delay(50);
    }
  }
  throw Error('runtime startup timeout');
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(timeoutMs).then(() => { throw Error(`runtime did not exit within ${timeoutMs} ms`); }),
  ]);
}

async function outputUntil(peer, sessionId, expression, message, geometry) {
  let cursor = 0;
  let output = '';
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = await peer.request('terminal.read', { sessionId, cursor, limit: 65_536 });
    assert.equal(page.fromCursor, cursor, 'terminal read cursor remains contiguous');
    if (page.nextCursor > cursor) {
      output += Buffer.from(page.data, 'base64').toString('utf8');
      cursor = page.nextCursor;
      if (expression.test(await terminalText(output, geometry))) return output;
    } else await delay(75);
  }
  throw Error(`${message}\n${(await terminalText(output, geometry)).slice(-2000)}`);
}

async function runPowerShellCommand(peer, sessionId, marker) {
  const { leaseEpoch } = await peer.request('session.claim', { sessionId, clientId: 'qa-default-shell' });
  try {
    // A pane-sized width, as a window would send. At the 80-column default the long scratch-path
    // prompt plus this line wraps exactly at the edge, where Windows PowerShell's bundled
    // PSReadLine 2.0.0 throws SetCursorPosition(left: -1) (an upstream bug, fixed in later PSReadLine).
    await peer.request('terminal.resize', { sessionId, cols: 160, rows: 30, leaseEpoch });
    await new Promise(done => setTimeout(done, 300));
    await peer.request('terminal.input', { sessionId, data: `Write-Output '${marker}'\r`, leaseEpoch });
  } finally {
    await peer.request('session.release', { sessionId, leaseEpoch }).catch(() => {});
  }
  await outputUntil(peer, sessionId, new RegExp(`^${marker}$`, 'm'), 'PowerShell command did not run', { cols: 160, rows: 30 });
}

async function setDefaultShell(peer, defaultShell) {
  const snapshot = await peer.request('runtime.snapshot');
  const settings = await peer.request('settings.update', {
    patch: { defaultShell }, expectedRevision: snapshot.settings.revision, operationId: randomUUID(),
  });
  assert.equal(settings.defaultShell, defaultShell, 'runtime persists the requested default shell');
}

try {
  await Promise.all([mkdir(data), mkdir(project), mkdir(providerBin)]);
  startDaemon();
  let peer = await connect();
  await setDefaultShell(peer, 'powershell');

  const original = await peer.request('session.create', {
    cwd: project, title: 'Default shell QA', provider: 'shell', mode: 'terminal', operationId: randomUUID(),
  });
  const originalOutput = await outputUntil(peer, original.id, /^PS .*>/m, 'Shell terminal did not start Windows PowerShell');
  assert.doesNotMatch(await terminalText(originalOutput), /Microsoft Windows \[Version/i, 'Shell terminal did not fall back to cmd.exe');
  const originalConfig = await peer.request('session.config.read', { sessionId: original.id });
  assert.equal(originalConfig.executable, 'powershell.exe', 'the resolved PowerShell executable is stored with the session launch');
  assert.ok(originalConfig.args.includes('-NoLogo'), 'stored PowerShell launch suppresses the banner');
  await runPowerShellCommand(peer, original.id, 'DEFAULT-SHELL-FIRST');
  await peer.request('session.stop', { sessionId: original.id, force: true, operationId: randomUUID() });

  // Changing the preference and restarting the runtime must not rewrite the stored launch.
  await setDefaultShell(peer, 'cmd');
  await peer.request('runtime.shutdown', { operationId: randomUUID() });
  await waitForExit(daemon);
  peer.close();
  startDaemon();
  peer = await connect();
  assert.equal((await peer.request('runtime.snapshot')).settings.defaultShell, 'cmd', 'changed preference survives runtime restart');

  const rerun = await peer.request('session.rerun', { sessionId: original.id, operationId: randomUUID() });
  const rerunOutput = await outputUntil(peer, rerun.id, /^PS .*>/m, 'rerun did not keep the original PowerShell launch');
  assert.doesNotMatch(await terminalText(rerunOutput), /Microsoft Windows \[Version/i, 'rerun incorrectly used the new cmd preference');
  const rerunConfig = await peer.request('session.config.read', { sessionId: rerun.id });
  assert.equal(rerunConfig.executable, 'powershell.exe', 'rerun keeps the stored executable');
  await runPowerShellCommand(peer, rerun.id, 'DEFAULT-SHELL-RERUN');
  await peer.request('session.stop', { sessionId: rerun.id, force: true, operationId: randomUUID() });
  console.log(JSON.stringify({ passed: true, checks: ['no-executable Shell session starts Windows PowerShell', 'PowerShell command executes', 'stored launch survives preference change and runtime restart', 'rerun preserves Windows PowerShell'] }));
} finally {
  for (const peer of peers) peer.close();
  if (daemon?.exitCode === null) {
    daemon.kill();
    await waitForExit(daemon).catch(() => {});
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
