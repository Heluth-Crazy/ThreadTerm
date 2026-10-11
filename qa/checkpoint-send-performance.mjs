// Isolated Desktop 1 performance QA for the real pre-send review checkpoint.
// The application uses a fake local Codex app-server and an isolated delayed
// MinGit forwarder. No paid provider, user profile, repository, or index is used.
//
//   node qa/checkpoint-send-performance.mjs --runtime <threadterm-v3-runtime.exe>
//   Optional: --git <official MinGit cmd/git.exe>

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { electron } from './lib/desktop1.mjs';
import { connectSubagentPeer as connectPeer } from './lib/subagent-peer.mjs';
import { PROTOCOL_CONTRACT } from '../protocol/index.ts';

assert.equal(process.platform, 'win32', 'this acceptance QA requires Windows');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const runtime = resolve(option('--runtime') ?? join(root, 'runtime', 'target-qa', 'debug', 'threadterm-v3-runtime.exe'));
const git = resolve(option('--git') ?? join(root, 'qa', 'results', 'selected-commit-tools', 'mingit-2.54.0', 'unpacked', 'cmd', 'git.exe'));
await Promise.all([access(runtime), access(git)]);
const runtimeSha256 = createHash('sha256').update(await readFile(runtime)).digest('hex');
const mingitRoot = dirname(dirname(git));
const mingitBin = join(mingitRoot, 'mingw64', 'bin');
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const system32 = join(systemRoot, 'System32');
const python = execFileSync('where.exe', ['python'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/u).find(Boolean);
const rustc = execFileSync('where.exe', ['rustc'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/u).find(Boolean);
assert.ok(python && rustc, 'Python and Rust compiler are required for this isolated fixture');

const runId = `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${randomUUID()}`;
const scratch = await mkdtemp(join(tmpdir(), 'tt-checkpoint-send-'));
const outDir = join(root, 'qa', 'results', 'checkpoint-send-performance');
const outPath = join(outDir, `${runId}.json`);
const bin = join(scratch, 'bin');
const projectPath = join(scratch, 'project');
const data = join(scratch, 'data');
const profile = join(scratch, 'profile');
const home = join(scratch, 'home');
const appData = join(scratch, 'appdata');
const localAppData = join(scratch, 'localappdata');
const temp = join(scratch, 'temp');
const configGlobal = join(scratch, 'gitconfig');
const pipe = `\\\\.\\pipe\\tt-checkpoint-send-${randomUUID()}`;
const runtimeLog = join(data, 'runtime.log');
const gitLog = join(scratch, 'git-calls.tsv');
const fakeLog = join(scratch, 'fake-codex.jsonl');
const fakeRelease = join(scratch, 'fake-codex.release');
const wrapperSource = join(scratch, 'git-forwarder.rs');
const wrapperExe = join(bin, 'git.exe');
const database = join(data, 'threadterm-v3.sqlite3');
const fixture = join(root, 'qa', 'fixtures', 'fake-codex-latency.cjs');
const promptPrefix = 'checkpoint performance synthetic turn';
const commandDelayMs = 1250;
const report = { runId, runtimeSha256, passed: false, delayPerGitProcessMs: commandDelayMs, sends: [], checks: [], error: undefined };
let app;
let page;
let session;
let cleanupFailure;
let runtimeStopped = false;
let lastConnectionState;
let currentStep = 'fixture setup';

const sleep = milliseconds => delay(milliseconds);
function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}
async function waitFor(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function isolatedAppEnvironment() {
  const stripped = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(path|home|userprofile|codex_home|appdata|localappdata|temp|tmp|threadterm_v3_.*|codex_|claude_|anthropic_|openai_|gemini_|opencode_|grok_|tt_qa_)/iu.test(key)));
  const childPath = [bin, dirname(process.execPath), system32].join(';');
  const env = Object.assign(stripped, {
    Path: childPath,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, '.codex'),
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_V3_DATA: data,
    THREADTERM_V3_USER_DATA: profile,
    THREADTERM_V3_PIPE: pipe,
    THREADTERM_V3_SEND_TRACE: '1',
    TT_QA_PYTHON: python,
    TT_QA_FAKE_CODEX_LOG: fakeLog,
    TT_QA_FAKE_CODEX_CWD: projectPath,
    TT_QA_FAKE_RELEASE_FILE: fakeRelease,
    TT_QA_RUNTIME_DB: database,
    TT_QA_PROMPT: promptPrefix,
  });
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1,
    'application child environment must contain one isolated PATH');
  assert.equal(env.Path, childPath);
  assert.equal(env.HOME, home);
  return env;
}

function isolatedGitEnvironment() {
  const stripped = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(path|home|userprofile|appdata|localappdata|temp|tmp|git_config_|git_dir|git_work_tree|threadterm_v3_.*|codex_|claude_|anthropic_|openai_|gemini_|opencode_|grok_|tt_qa_)/iu.test(key)));
  return {
    ...stripped,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: configGlobal,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    PATH: [mingitBin, join(mingitRoot, 'cmd'), system32].join(';'),
  };
}

function hostGit(args) {
  return execFileSync(git, args, {
    cwd: projectPath, env: isolatedGitEnvironment(), windowsHide: true, stdio: 'pipe',
  });
}

async function indexHash() {
  return createHash('sha256').update(await readFile(join(projectPath, '.git', 'index'))).digest('hex');
}

async function traceRows() {
  const rows = [];
  for (const line of (await readFile(runtimeLog, 'utf8').catch(() => '')).split(/\r?\n/u)) {
    try {
      const row = JSON.parse(line);
      if (row?.kind === 'threadterm.sendTrace' && row.source === 'runtime') rows.push(row);
    } catch { /* Runtime logs also contain ordinary diagnostics. */ }
  }
  return rows;
}

async function gitLogRows() {
  return (await readFile(gitLog, 'utf8').catch(() => '')).split(/\r?\n/u).filter(Boolean).map(line => {
    const [command, elapsed] = line.split('\t');
    return { command, elapsedUs: Number(elapsed) };
  });
}

async function readCheckpoint(operationId) {
  const source = String.raw`import json,pathlib,sqlite3,sys
uri=pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro'
db=sqlite3.connect(uri,uri=True)
row=db.execute('SELECT id,kind,label,status,tree,store FROM review_checkpoints WHERE operation_id=?',(sys.argv[2],)).fetchone()
print(json.dumps(row))`;
  const stdout = execFileSync(python, ['-c', source, database, operationId], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [id, kind, label, status, tree, store] = JSON.parse(stdout.trim());
  assert.ok(id && tree && store, 'checkpoint must persist its canonical tree and private object store');
  assert.equal(kind, 'turn');
  assert.equal(label, promptPrefix);
  assert.equal(status, 'ready', 'trace outcome recorded does not imply a ready checkpoint row');
  return { id, tree, store };
}

function checkpointBlob(checkpoint, path) {
  const objectEnv = isolatedGitEnvironment();
  objectEnv.GIT_OBJECT_DIRECTORY = checkpoint.store;
  objectEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES = join(projectPath, '.git', 'objects');
  return execFileSync(git, ['-C', projectPath, 'cat-file', 'blob', `${checkpoint.tree}:${path}`], {
    env: objectEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function readTraceRowsNow() { return traceRows(); }

async function makeChat(rpc) {
  currentStep = 'project.add';
  const project = await rpc('project.add', { path: projectPath, name: 'Synthetic checkpoint QA', operationId: randomUUID() });
  currentStep = 'session.create';
  const created = await rpc('session.create', {
    projectId: project.id, cwd: projectPath, title: 'Synthetic checkpoint QA', provider: 'codex', mode: 'chat', operationId: randomUUID(),
  });
  const owned = { session: created, leaseEpoch: undefined };
  session = owned;
  currentStep = 'session.claim';
  const lease = await rpc('session.claim', { sessionId: created.id, clientId: 'checkpoint-send-qa' });
  owned.leaseEpoch = lease.leaseEpoch;
  currentStep = 'chat.connect';
  await rpc('chat.connect', { sessionId: created.id, leaseEpoch: lease.leaseEpoch, operationId: randomUUID() });
  currentStep = 'chat.connection';
  await waitFor(async () => {
    lastConnectionState = await rpc('chat.connection', { sessionId: created.id });
    return lastConnectionState.phase === 'ready';
  }, 'fake Codex chat connection');
  return owned;
}

async function sendTurn(rpc, turnNumber, expectedFiles, originalIndexHash, originalPorcelain) {
  currentStep = `send ${turnNumber}: chat.send`;
  const operationId = randomUUID();
  const started = performance.now();
  await rpc('chat.send', {
    sessionId: session.session.id,
    text: promptPrefix,
    operationId,
    leaseEpoch: session.leaseEpoch,
  });
  const responseMs = performance.now() - started;
  assert.ok(responseMs < 10_000, `send ${turnNumber} exceeded the 10-second handoff budget (${Math.round(responseMs)}ms)`);
  const rows = await waitFor(async () => {
    const current = await readTraceRowsNow();
    return current.some(row => row.operationId === operationId && row.stage === 'service.chat_send.end') ? current : undefined;
  }, `send ${turnNumber} trace flush`);
  const correlated = rows.filter(row => row.operationId === operationId);
  const checkpointEnd = correlated.find(row => row.stage === 'review.checkpoint.end');
  assert.equal(checkpointEnd?.outcome, 'recorded', 'checkpoint callback must have recorded an operation row');
  assert.ok(Number.isSafeInteger(checkpointEnd.durationUs) && checkpointEnd.durationUs < 10_000_000,
    'checkpoint capture itself must complete inside its 10-second budget');
  const handoff = correlated.find(row => row.stage === 'provider.handoff.end');
  assert.equal(handoff?.outcome, 'ok', 'fake Codex must accept the native turn handoff');
  const expectedCommands = ['rev-parse', 'status', 'update-index', 'write-tree'];
  const spawns = correlated.filter(row => row.stage === 'review.git.spawn').map(row => row.step);
  const exits = correlated.filter(row => row.stage === 'review.git.exit');
  for (const command of expectedCommands) {
    assert.equal(spawns.filter(step => step === command).length, 1, `send ${turnNumber} must run one ${command}`);
    assert.equal(exits.filter(row => row.step === command && row.outcome === 'ok').length, 1,
      `send ${turnNumber} ${command} must exit successfully`);
  }
  assert.ok(exits.filter(row => expectedCommands.includes(row.step))
    .every(row => row.durationUs >= (commandDelayMs - 40) * 1000),
  `send ${turnNumber} checkpoint Git child processes must each experience the configured delay`);
  assert.equal(spawns.length, expectedCommands.length, `send ${turnNumber} should use the four expected Git commands`);

  const checkpoint = await readCheckpoint(operationId);
  for (const [path, contents] of Object.entries(expectedFiles)) {
    assert.deepEqual(checkpointBlob(checkpoint, path), Buffer.from(contents),
      `checkpoint ${turnNumber} must retain exact bytes for ${path}`);
  }
  assert.equal(await indexHash(), originalIndexHash, 'checkpointing must leave the real index byte-for-byte unchanged');
  assert.deepEqual(hostGit(['status', '--porcelain=v1', '-z']), originalPorcelain,
    'checkpointing must preserve the native staged and unstaged status');

  report.sends.push({
    turn: turnNumber,
    responseMs: Math.round(responseMs),
    checkpointUs: checkpointEnd.durationUs,
    gitCommands: exits.filter(row => expectedCommands.includes(row.step))
      .map(row => ({ command: row.step, elapsedMs: Math.round(row.durationUs / 1000) })),
    checkpoint: 'ready',
    blobsVerified: Object.keys(expectedFiles).length,
    realIndexUnchanged: true,
    provider: 'fake local Codex app-server',
  });
  await waitFor(async () => (await rpc('runtime.snapshot')).sessions.find(item => item.id === session.session.id)?.status === 'idle',
    `fake Codex turn ${turnNumber} completion`);
}

async function stopOwnedRuntime() {
  let peer;
  try {
    peer = await connectPeer(`${pipe}-control`);
    const credential = (await readFile(join(data, 'runtime.credential'), 'utf8')).trim();
    assert.ok(credential);
    await peer.auth(credential);
    currentStep = 'cleanup: runtime.snapshot';
    const snapshot = await peer.request('runtime.snapshot', {});
    if (session) {
      assert.equal(snapshot.sessions.length, 1, 'cleanup must only stop the one session created by this fixture');
      assert.equal(snapshot.sessions[0].id, session.session.id);
      assert.equal(snapshot.sessions[0].provider, 'codex', 'cleanup must only stop the fake Codex session');
      if (!['exited', 'interrupted', 'error'].includes(snapshot.sessions[0].status)) {
        currentStep = 'cleanup: session.stop';
        await peer.request('session.stop', { sessionId: session.session.id, operationId: randomUUID(), force: true });
        currentStep = 'cleanup: verify session stopped';
        const stopped = await peer.request('runtime.snapshot', {});
        assert.equal(stopped.sessions.length, 1);
        assert.equal(stopped.sessions[0].id, session.session.id);
        assert.ok(['exited', 'interrupted', 'error'].includes(stopped.sessions[0].status),
          'the exact synthetic Codex session must be stopped before runtime shutdown');
      }
    } else assert.equal(snapshot.sessions.length, 0, 'cleanup must stop only an empty fixture runtime');
    currentStep = 'cleanup: runtime.shutdown';
    await peer.request('runtime.shutdown', { operationId: randomUUID() });
    runtimeStopped = true;
    report.checks.push('authenticated shutdown stopped only the fixture-private runtime and fake Codex session');
  } catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes(error?.code)) {
      runtimeStopped = true;
      report.checks.push('fixture runtime had already released its private pipe');
    } else throw error;
  } finally { peer?.close(); }
}

async function verifyPipeClosed() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const peer = await connectPeer(`${pipe}-control`);
      peer.close();
      await sleep(100);
    } catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error?.code)) return;
      throw error;
    }
  }
  throw new Error('fixture-private runtime pipe remained open after cleanup');
}

try {
  process.env.TT_QA_DESKTOP = '1';
  await mkdir(outDir, { recursive: true });
  await Promise.all([bin, projectPath, data, profile, home, appData, localAppData, temp].map(path => mkdir(path, { recursive: true })));
  await Promise.all([writeFile(configGlobal, ''), writeFile(gitLog, ''), writeFile(fakeLog, ''), writeFile(fakeRelease, 'go')]);

  const wrapper = String.raw`use std::{env,fs::{self,OpenOptions},io::Write,process::{Command,Stdio},thread,time::{Duration,Instant},os::windows::process::CommandExt};
const H:u32=0x08000000;
fn main(){
 let args:Vec<_>=env::args_os().skip(1).collect();
 let command=args.get(4).map(|value|value.to_string_lossy().into_owned()).unwrap_or_else(||"unknown".into());
 let started=Instant::now();
 thread::sleep(Duration::from_millis(env::var("TT_QA_GIT_DELAY_MS").unwrap().parse().unwrap()));
 let status=Command::new(env::var_os("TT_QA_REAL_GIT").unwrap()).args(&args).stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).env("PATH",env::var_os("TT_QA_GIT_CHILD_PATH").unwrap()).env("GIT_CONFIG_NOSYSTEM","1").env("GIT_CONFIG_GLOBAL",env::var_os("TT_QA_GIT_CONFIG_GLOBAL").unwrap()).creation_flags(H).status().unwrap();
 let mut log=OpenOptions::new().create(true).append(true).open(env::var("TT_QA_GIT_LOG").unwrap()).unwrap();
 writeln!(log,"{}\t{}",command,started.elapsed().as_micros()).unwrap();
 std::process::exit(status.code().unwrap_or(1));
}`;
  await writeFile(wrapperSource, wrapper);
  execFileSync(rustc, [wrapperSource, '-O', '-o', wrapperExe], { stdio: 'pipe', windowsHide: true });
  const gitEnv = isolatedGitEnvironment();
  const minGitChildPath = [mingitBin, join(mingitRoot, 'cmd'), system32].join(';');
  const baseEnv = { ...gitEnv, GIT_CONFIG_GLOBAL: configGlobal };
  execFileSync(git, ['init', '-q', '-b', 'main'], { cwd: projectPath, env: baseEnv, windowsHide: true, stdio: 'pipe' });
  execFileSync(git, ['config', 'user.email', 'qa@example.test'], { cwd: projectPath, env: baseEnv, windowsHide: true, stdio: 'pipe' });
  execFileSync(git, ['config', 'user.name', 'Checkpoint QA'], { cwd: projectPath, env: baseEnv, windowsHide: true, stdio: 'pipe' });
  await writeFile(join(projectPath, 'tracked.txt'), 'tracked baseline\n');
  execFileSync(git, ['add', 'tracked.txt'], { cwd: projectPath, env: baseEnv, windowsHide: true, stdio: 'pipe' });
  execFileSync(git, ['commit', '-q', '-m', 'baseline'], { cwd: projectPath, env: baseEnv, windowsHide: true, stdio: 'pipe' });
  const stagedV1 = 'existing staged bytes v1\n';
  const trackedV1 = 'tracked working bytes v1\n';
  const untrackedV1 = 'untracked working bytes v1\n';
  await writeFile(join(projectPath, 'staged.txt'), stagedV1);
  execFileSync(git, ['add', 'staged.txt'], { cwd: projectPath, env: baseEnv, windowsHide: true, stdio: 'pipe' });
  await writeFile(join(projectPath, 'tracked.txt'), trackedV1);
  await writeFile(join(projectPath, 'untracked.txt'), untrackedV1);
  const stagedNames = execFileSync(git, ['diff', '--cached', '--name-only'], { cwd: projectPath, env: baseEnv, encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/u);
  assert.deepEqual(stagedNames, ['staged.txt']);
  const originalIndexHash = createHash('sha256').update(await readFile(join(projectPath, '.git', 'index'))).digest('hex');
  const originalPorcelain = execFileSync(git, ['status', '--porcelain=v1', '-z'], { cwd: projectPath, env: baseEnv, windowsHide: true });
  assert.ok(originalPorcelain.includes(Buffer.from('staged.txt')) && originalPorcelain.includes(Buffer.from('tracked.txt')) && originalPorcelain.includes(Buffer.from('untracked.txt')));

  const env = {
    ...isolatedAppEnvironment(),
    TT_QA_REAL_GIT: git,
    TT_QA_GIT_CHILD_PATH: minGitChildPath,
    TT_QA_GIT_CONFIG_GLOBAL: configGlobal,
    TT_QA_GIT_DELAY_MS: String(commandDelayMs),
    TT_QA_GIT_LOG: gitLog,
  };
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
  app = await electron.launch({
    args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', root],
    cwd: bin,
    env,
    timeout: 60_000,
  });
  currentStep = 'Desktop 1: first window';
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(25_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('#boot-splash').waitFor({ state: 'detached' });
  const rpc = (method, params = {}) => {
    currentStep = `RPC ${method}`;
    return withTimeout(
      page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]),
      30_000,
      `RPC ${method} did not return within 30 seconds`,
    );
  };
  currentStep = 'RPC runtime.health';
  const health = await rpc('runtime.health');
  assert.equal(health.contract, PROTOCOL_CONTRACT);
  const initial = await rpc('runtime.snapshot');
  currentStep = 'RPC settings.update';
  await rpc('settings.update', {
    patch: { notifications: { native: false, attention: false, completed: false, sound: false } },
    expectedRevision: initial.settings.revision,
    operationId: randomUUID(),
  });
  report.checks.push('production Electron main, renderer, and isolated runtime launched on Desktop 1 with a unique profile, data directory, and named pipe');
  report.checks.push('Git used an isolated official MinGit binary with an isolated HOME and no system or user Git configuration');
  report.checks.push('fixture repo contains one pre-existing staged file, one modified tracked file, and one untracked file');
  session = await makeChat(rpc);

  await sendTurn(rpc, 1, { 'staged.txt': stagedV1, 'tracked.txt': trackedV1, 'untracked.txt': untrackedV1 }, originalIndexHash, originalPorcelain);

  const stagedV2 = 'existing staged bytes v2 working tree\n';
  const trackedV2 = 'tracked working bytes v2\n';
  const untrackedV2 = 'untracked working bytes v2\n';
  await writeFile(join(projectPath, 'staged.txt'), stagedV2);
  await writeFile(join(projectPath, 'tracked.txt'), trackedV2);
  await writeFile(join(projectPath, 'untracked.txt'), untrackedV2);
  const secondPorcelain = hostGit(['status', '--porcelain=v1', '-z']);
  await sendTurn(rpc, 2, { 'staged.txt': stagedV2, 'tracked.txt': trackedV2, 'untracked.txt': untrackedV2 }, originalIndexHash, secondPorcelain);

  const fakeRows = (await readFile(fakeLog, 'utf8')).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  const starts = fakeRows.filter(row => row.direction === 'in' && row.method === 'turn/start');
  assert.equal(starts.length, 2, 'exactly two synthetic provider turns must be submitted');
  assert.ok(starts.every(row => row.durableUser === true), 'fake Codex must observe the durable user event before each handoff');
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send(
    'threadterm:desktop-navigate', { sessionId: id }), session.session.id);
  const chat = page.locator(`[data-testid="session-chat-${session.session.id}"]`);
  await chat.locator('.chat-compose-shell textarea').waitFor({ state: 'visible' });
  await waitFor(async () => (await chat.locator('.v3-chat-message.assistant').allInnerTexts())
    .some(text => text.includes('fake latency answer')), 'actual synthetic Codex chat response');
  const traceJson = JSON.stringify(await traceRows());
  for (const privateValue of [root, scratch, projectPath, promptPrefix]) {
    assert.ok(!traceJson.includes(privateValue), 'runtime send trace must not include repository paths, fixture paths, or prompt text');
  }
  report.checks.push('runtime send traces contain no repository paths, fixture paths, or prompt text');
  await page.screenshot({ path: join(outDir, `${runId}-actual-chat.png`), animations: 'disabled' });
  report.screenshot = `${runId}-actual-chat.png`;
  report.checks.push('actual synthetic Codex conversation was opened and captured for visual review');
  report.checks.push('both sends reached only the fake local Codex app-server after durable user persistence');
  report.passed = true;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  report.failureStage = currentStep;
  if (lastConnectionState) {
    report.chatConnection = Object.fromEntries(['phase', 'status', 'failureCode', 'reasonCode']
      .filter(key => typeof lastConnectionState[key] === 'string')
      .map(key => [key, lastConnectionState[key]]));
  }
  report.fakeCodexMethods = (await readFile(fakeLog, 'utf8').catch(() => ''))
    .split(/\r?\n/u).filter(Boolean).flatMap(line => {
      try { const row = JSON.parse(line); return typeof row.method === 'string' ? [row.method] : []; }
      catch { return []; }
    });
  report.runtimeTraceStages = (await traceRows()).map(row => row.stage);
  report.error = message
    .replaceAll(scratch, '<fixture>')
    .replaceAll(root, '<repo>')
    .replaceAll(promptPrefix, '<prompt>');
} finally {
  if (app) {
    const child = app.process?.();
    currentStep = 'cleanup: Desktop 1 Electron exit';
    if (child?.exitCode === null) {
      await withTimeout(
        app.evaluate(({ app: electronApp }) => electronApp.exit(0)),
        5_000,
        'Desktop 1 Electron exit request timed out',
      ).catch(error => { if (child.exitCode === null) cleanupFailure ??= error; });
      if (child.exitCode === null) {
        await withTimeout(once(child, 'exit'), 10_000, 'owned Desktop 1 process did not exit').catch(error => {
          if (child.exitCode === null) cleanupFailure ??= error;
        });
      }
    }
    currentStep = 'cleanup: Desktop 1 Playwright close';
    await withTimeout(app.close(), 10_000, 'Desktop 1 Playwright close timed out')
      .catch(error => { if (child?.exitCode === null) cleanupFailure ??= error; });
    if (child?.exitCode === null && cleanupFailure) {
      child.kill();
      await withTimeout(once(child, 'exit'), 5_000, 'owned Desktop 1 process did not exit after close').catch(() => {});
    }
  }
  try { await stopOwnedRuntime(); } catch (error) { cleanupFailure ??= error; }
  if (runtimeStopped) {
    try { await verifyPipeClosed(); }
    catch (error) { cleanupFailure ??= error; }
  }
  if (cleanupFailure) {
    report.passed = false;
    report.cleanupError = `fixture-specific cleanup failed${cleanupFailure?.code ? ` (${cleanupFailure.code})` : ''} at ${currentStep}`;
  }
  if (!report.passed || cleanupFailure) report.fixtureScratchRetained = true;
  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  if (report.passed && runtimeStopped && !cleanupFailure) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) process.exitCode = 1;
}
