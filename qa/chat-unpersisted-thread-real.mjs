// Real Codex regression QA for chats whose native thread has no user turn.
// It uses an isolated CODEX_HOME and ThreadTerm data root, and never starts a
// model turn. Run after building runtime/target-qa:
//   node qa/chat-unpersisted-thread-real.mjs
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const out = join(root, 'qa/results/chat-unpersisted-thread-real');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-unpersisted-thread-'));
const appDir = join(scratch, 'app');
const workspace = join(scratch, 'workspace');
const data = join(scratch, 'data');
const codexHome = join(scratch, 'codex-home');
const profile = join(scratch, 'profile');
const bin = join(scratch, 'bin');
const piAgent = join(scratch, 'pi-agent');
const piSessions = join(scratch, 'pi-sessions');
const piLog = join(scratch, 'pi-launches.jsonl');
const database = join(data, 'threadterm-v3.sqlite3');
const report = { passed: false, runtime, scratch, checks: [], ids: {}, errors: [], processStops: [], forceKilled: [] };
let app;
let appIdentity;
let page;
let env;
let sqlite;
const nativeServers = new Set();

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
async function until(probe, label, timeout = 45_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await probe(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}${last ? `: ${last.message}` : ''}`);
}
function where(name) {
  const found = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/u).filter(Boolean);
  assert.ok(found.length, `${name} was not found on PATH`);
  return found[0];
}
function sql(value) { return `'${String(value).replaceAll("'", "''")}'`; }
async function buildApp() {
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) {
    await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  }
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'chat-unpersisted-thread-qa', version: '0.1.0', main: 'main.cjs' }));
}
async function startApp() {
  env.THREADTERM_V3_PIPE = `\\\\.\\pipe\\tt-unpersisted-${randomUUID()}`;
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: workspace, env, timeout: 60_000 });
  appIdentity = (await processSnapshot()).find(row => row.ProcessId === app.process().pid);
  assert.ok(appIdentity?.StartedAt, 'QA Electron process identity is available');
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(30_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await rpc('runtime.health');
}
async function processSnapshot() {
  assert.equal(process.platform, 'win32', 'this process-tree QA requires Windows');
  const command = `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,@{Name='StartedAt';Expression={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null}}} | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', command], { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}
function descendants(parentPid, snapshot) {
  const seen = new Set([parentPid]);
  const pending = [parentPid];
  const found = [];
  while (pending.length) {
    const parent = pending.shift();
    for (const row of snapshot) {
      if (row.ParentProcessId !== parent || seen.has(row.ProcessId)) continue;
      seen.add(row.ProcessId);
      found.push(row);
      pending.push(row.ProcessId);
    }
  }
  return found;
}
const sameProcess = (left, right) => left?.ProcessId === right?.ProcessId && left?.StartedAt === right?.StartedAt;
const executableKey = path => path ? resolve(path).replace(/^\\\\\?\\/u, '').toLowerCase() : undefined;
async function stopOwnedTree(identity, reason, { requireRuntime = false, shutdown } = {}) {
  assert.ok(identity?.ProcessId && identity.StartedAt, 'termination requires an owned process identity');
  const snapshot = await processSnapshot();
  const current = snapshot.find(row => row.ProcessId === identity.ProcessId);
  assert.ok(!current || sameProcess(current, identity), `refusing to terminate reused PID ${identity.ProcessId}`);
  const children = descendants(identity.ProcessId, snapshot);
  const owned = children.filter(row => executableKey(row.ExecutablePath) === executableKey(runtime));
  if (requireRuntime) assert.ok(owned.length > 0, `no QA runtime beneath Electron: ${JSON.stringify(children)}`);
  const ownedPids = new Set(owned.map(row => row.ProcessId));
  const parents = new Map(snapshot.map(row => [row.ProcessId, row.ParentProcessId]));
  const hasRuntimeAncestor = row => {
    const seen = new Set([row.ProcessId]);
    for (let pid = row.ParentProcessId; pid && !seen.has(pid); pid = parents.get(pid)) {
      if (ownedPids.has(pid)) return true;
      seen.add(pid);
    }
    return false;
  };
  const record = {
    reason, rootPid: identity.ProcessId, pipe: env?.THREADTERM_V3_PIPE,
    runtimePids: [...ownedPids], runtimeRootPids: owned.filter(row => !hasRuntimeAncestor(row)).map(row => row.ProcessId),
    codexPids: children.filter(row => /^codex(?:\.exe)?$/iu.test(row.Name ?? '')).map(row => row.ProcessId),
    observedProcesses: [...(current ? [current] : []), ...children], commands: [], killedPids: [], confirmedExitedPids: [],
  };
  report.processStops.push(record);
  if (requireRuntime) report.forceKilled.push(record);
  // Close the QA Electron owner too: its reconnect client must not respawn a
  // daemon while we are seeding the stopped database or starting a new pipe.
  if (shutdown) {
    try { await shutdown(); } catch (error) { record.shutdownError = error.message; }
  }
  const observed = new Map(record.observedProcesses.map(row => [row.ProcessId, row]));
  await until(async () => {
    const live = await processSnapshot();
    const byPid = new Map(live.map(row => [row.ProcessId, row]));
    // Include children started while graceful shutdown was being acknowledged.
    for (const row of [...observed.values()]) {
      if (!sameProcess(byPid.get(row.ProcessId), row)) continue;
      for (const child of descendants(row.ProcessId, live)) observed.set(child.ProcessId, child);
    }
    const survivors = [...observed.values()].filter(row => sameProcess(byPid.get(row.ProcessId), row));
    record.observedProcesses = [...observed.values()];
    if (!survivors.length) {
      record.confirmedExitedPids = [...observed.keys()];
      return true;
    }
    const survivorPids = new Set(survivors.map(row => row.ProcessId));
    for (const row of survivors.filter(row => !survivorPids.has(row.ParentProcessId))) {
      // Revalidate creation time immediately before each PID-scoped tree kill.
      const latest = await processSnapshot();
      if (!sameProcess(latest.find(value => value.ProcessId === row.ProcessId), row)) continue;
      const attempt = { rootPid: row.ProcessId, pids: [row, ...descendants(row.ProcessId, latest)].map(value => value.ProcessId) };
      for (const child of descendants(row.ProcessId, latest)) observed.set(child.ProcessId, child);
      record.commands.push(attempt);
      try {
        const result = await execFileAsync('taskkill', ['/pid', String(row.ProcessId), '/t', '/f'], { windowsHide: true, timeout: 10_000 });
        attempt.stdout = result.stdout;
        attempt.stderr = result.stderr;
      } catch (error) {
        attempt.error = error.message;
        attempt.stdout = error.stdout;
        attempt.stderr = error.stderr;
      }
      // Only the first PID on a success line is terminated; later PIDs name
      // its parent (which can be this QA runner, outside the killed tree).
      attempt.reportedPids = (attempt.stdout ?? '').split(/\r?\n/u)
        .map(line => line.match(/\bPID\D{0,12}(\d+)/iu)?.[1]).filter(Boolean).map(Number);
      record.killedPids = [...new Set([...record.killedPids, ...attempt.pids, ...attempt.reportedPids])];
    }
    return false;
  }, `${reason}: all owned processes exited`, 20_000);
  record.observedProcesses = [...observed.values()];
}
async function forceKillRuntimeTree() {
  await stopOwnedTree(appIdentity, 'forced QA crash', { requireRuntime: true });
}
async function stopApp({ forceRuntime = false } = {}) {
  if (forceRuntime && app) await forceKillRuntimeTree();
  else if (app) await stopOwnedTree(appIdentity, 'QA shutdown', {
    shutdown: page ? () => rpc('runtime.shutdown', { operationId: randomUUID() }) : undefined,
  });
  app = undefined;
  appIdentity = undefined;
  page = undefined;
}
async function nativeServer() {
  const child = spawn(env.TT_QA_CODEX_EXE, ['app-server'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const server = { child };
  nativeServers.add(server);
  const pending = new Map();
  let buffer = '';
  let next = 0;
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const resolver = pending.get(message.id);
      if (resolver) { pending.delete(message.id); resolver(message); }
    }
  });
  const rejectPending = message => { for (const resolvePending of pending.values()) resolvePending({ error: { message } }); pending.clear(); };
  child.once('error', error => rejectPending(error.message));
  child.once('exit', (code, signal) => rejectPending(`Codex app-server exited before its response (code=${code}, signal=${signal})`));
  const request = async (method, params) => {
    const id = `qa-${++next}`;
    const response = await new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => { pending.delete(id); rejectResponse(new Error(`Timed out waiting for ${method}: ${stderr}`)); }, 30_000);
      pending.set(id, message => { clearTimeout(timer); resolveResponse(message); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    if (response.error) throw new Error(`${method}: ${response.error.message ?? JSON.stringify(response.error)}`);
    return response.result;
  };
  try {
    server.identity = (await processSnapshot()).find(row => row.ProcessId === child.pid && row.ParentProcessId === process.pid);
    assert.ok(server.identity?.StartedAt, 'seed app-server process identity is available');
    await request('initialize', { clientInfo: { name: 'threadterm-qa', title: 'ThreadTerm QA', version: '0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    Object.assign(server, { request, stderr: () => stderr });
    return server;
  } catch (error) {
    await terminateNative(server);
    throw error;
  }
}
async function terminateNative(server) {
  // A parent may already have exited while one of its helpers is still alive.
  if (server.identity) await stopOwnedTree(server.identity, 'unpersisted seed app-server');
  else assert.ok(!server.child.pid || server.child.exitCode !== null || server.child.signalCode !== null, 'unidentified seed process may still be running');
  nativeServers.delete(server);
}
async function createUnpersistedThread() {
  const server = await nativeServer();
  try {
    const started = await server.request('thread/start', { cwd: workspace, threadSource: 'user' });
    const id = (started.thread ?? started).id;
    assert.match(id ?? '', /^[0-9a-f-]{36}$/i, 'thread/start returned a UUID');
    return id;
  } finally {
    await terminateNative(server);
  }
}
async function patchSeed(sessionId, nativeId, item) {
  assert.ok(existsSync(database), `missing isolated database ${database}`);
  const statements = [
    'PRAGMA foreign_keys=ON;',
    'BEGIN IMMEDIATE;',
    `UPDATE sessions SET native_id=${sql(nativeId)}, status='starting', updated_at=${sql(new Date().toISOString())} WHERE id=${sql(sessionId)};`,
    item ? `INSERT INTO chat_items(id,session_id,turn_id,kind,data,created_at) VALUES (${sql(item.id)},${sql(sessionId)},NULL,'message',${sql(JSON.stringify(item))},${sql(item.createdAt)});` : '',
    'COMMIT;',
    `SELECT native_id FROM sessions WHERE id=${sql(sessionId)};`,
  ].filter(Boolean).join(' ');
  const { stdout } = await execFileAsync(sqlite, [database, statements], { windowsHide: true });
  assert.equal(stdout.trim(), nativeId, 'seeded row owns the intended missing native ID');
}
async function presentAndWait(sessionId, phase) {
  await rpc('session.present', { sessionId, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  return until(async () => {
    const connection = await rpc('chat.connection', { sessionId });
    return connection.phase === phase ? connection : undefined;
  }, `${sessionId} ${phase}`);
}
async function assertEmptyTranscriptAndNativeHistory(sessionId, nativeId, label) {
  const snapshot = await rpc('chat.snapshot', { sessionId });
  assert.deepEqual(snapshot.items, [], `${label}: injected empty developer item is absent from the ThreadTerm transcript`);
  assert.deepEqual(await rpc('history.read', { provider: 'codex', nativeId }), [], `${label}: injected empty developer item is absent from imported native history`);
}
async function piJsonlFiles(directory) {
  const entries = await readdir(directory, { recursive: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries.filter(entry => String(entry).endsWith('.jsonl'));
}
async function piLaunches() {
  const raw = await readFile(piLog, 'utf8').catch(() => '');
  // The shim appends while this file is read; ignore only an unfinished tail.
  return raw.split(/\r?\n/u).slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
}
async function waitForPiLaunch(sessionId, nativeId, after) {
  return until(async () => {
    const events = await piLaunches();
    const launch = events.slice(after).find(event => event.event === 'spawn'
      && event.args.includes('--session-id')
      && event.args[event.args.indexOf('--session-id') + 1] === nativeId);
    if (!launch) return false;
    assert.ok(!events.some(event => event.event === 'exit' && event.pid === launch.pid && event.startedAt === launch.startedAt), 'real Pi launcher exited before the crash checkpoint');
    const snapshot = await processSnapshot();
    const children = descendants(appIdentity.ProcessId, snapshot);
    assert.ok(children.some(row => row.ProcessId === launch.pid), 'fresh Pi shim belongs to the current QA process tree');
    if (!children.some(row => row.ProcessId === launch.childPid)) return false;
    const nativePi = descendants(launch.childPid, snapshot).find(row => /^node(?:\.exe)?$/iu.test(row.Name ?? '')
      && row.CommandLine?.includes(nativeId));
    if (!nativePi) return false;
    launch.nativePid = nativePi.ProcessId;
    const session = (await rpc('runtime.snapshot')).sessions.find(value => value.id === sessionId);
    assert.equal(session?.nativeId, nativeId, 'Pi keeps the same durable native ID');
    assert.equal(session.status, 'running', 'Pi resumed session is running');
    report.piLaunches ??= [];
    report.piLaunches.push(launch);
    return launch;
  }, `real Pi launch for ${nativeId}`);
}

try {
  assert.ok(existsSync(runtime), `missing target-qa runtime; build it first: ${runtime}`);
  await rm(out, { recursive: true, force: true });
  await Promise.all([workspace, data, codexHome, profile, bin, piAgent, piSessions, out].map(path => mkdir(path, { recursive: true })));
  await buildApp();
  const codex = where('codex.exe');
  const git = where('git.exe');
  sqlite = where('sqlite3.exe');
  const pi = where('pi.cmd');
  await writeFile(piLog, '');
  await writeFile(join(scratch, 'pi-wrapper.mjs'), `import { appendFileSync } from 'node:fs'; import { spawn } from 'node:child_process';
const args=process.argv.slice(2), startedAt=new Date().toISOString();
const record=value=>appendFileSync(process.env.TT_QA_PI_LOG,JSON.stringify({pid:process.pid,startedAt,args,...value})+'\\n');
const child=spawn(process.env.TT_QA_REAL_PI,args,{cwd:process.cwd(),env:process.env,stdio:'inherit',shell:true,windowsHide:true});
child.on('spawn',()=>record({event:'spawn',childPid:child.pid}));
child.on('error',error=>{record({event:'exit',error:error.message});process.exit(1)});
child.on('exit',(code,signal)=>{record({event:'exit',childPid:child.pid,code,signal});process.exit(code??(signal?1:0))});`);
  await writeFile(join(bin, 'pi.cmd'), `@echo off\r\n"${process.execPath}" "${join(scratch, 'pi-wrapper.mjs')}" %*\r\n`);
  env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|codex_home|openai_api_key|codex_api_key|home|userprofile|appdata|localappdata|threadterm_v3_.*|tt_qa_.*)$/i.test(key)));
  Object.assign(env, {
    Path: [bin, dirname(codex), dirname(process.execPath), dirname(git), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    CODEX_HOME: codexHome,
    THREADTERM_V3_DATA: data,
    THREADTERM_V3_USER_DATA: profile,
    THREADTERM_V3_RUNTIME: runtime,
    TT_QA_CODEX_EXE: codex,
    TT_QA_SQLITE_EXE: sqlite,
    TT_QA_REAL_PI: pi,
    TT_QA_PI_LOG: piLog,
    PI_CODING_AGENT_DIR: piAgent,
    PI_CODING_AGENT_SESSION_DIR: piSessions,
    OPENAI_API_KEY: 'threadterm-qa-dummy-no-model-key',
  });
  assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path'], 'one isolated PATH spelling');
  const dummyLogin = spawnSync(codex, ['login', '--with-api-key'], { cwd: workspace, env, encoding: 'utf8', input: 'threadterm-qa-not-a-real-key\n', windowsHide: true });
  report.dummyLogin = { exitCode: dummyLogin.status, stdout: dummyLogin.stdout, stderr: dummyLogin.stderr };
  assert.equal(dummyLogin.status, 0, `isolated dummy API-key login failed: ${dummyLogin.stderr || dummyLogin.stdout}`);
  const login = spawnSync(codex, ['login', 'status'], { cwd: workspace, env, encoding: 'utf8', windowsHide: true });
  report.loginStatus = { exitCode: login.status, stdout: login.stdout, stderr: login.stderr };
  assert.equal(login.status, 0, `isolated dummy API-key login status failed: ${login.stderr || login.stdout}`);
  check('isolated dummy API key is accepted by codex login status without a model turn');

  await startApp();
  const project = await rpc('project.add', { path: workspace, name: 'Unpersisted Codex QA', operationId: randomUUID() });
  const fresh = await rpc('session.create', { projectId: project.id, cwd: workspace, provider: 'codex', mode: 'chat', title: 'persisted empty chat', operationId: randomUUID() });
  const empty = await rpc('session.create', { projectId: project.id, cwd: workspace, provider: 'codex', mode: 'chat', title: 'missing empty chat', operationId: randomUUID() });
  const withMessage = await rpc('session.create', { projectId: project.id, cwd: workspace, provider: 'codex', mode: 'chat', title: 'missing message chat', operationId: randomUUID() });
  const freshConnection = await presentAndWait(fresh.id, 'ready');
  const freshNativeId = freshConnection.nativeId;
  assert.match(freshNativeId ?? '', /^[0-9a-f-]{36}$/i, 'new chat received a native id');
  report.ids.fresh = freshNativeId;
  await assertEmptyTranscriptAndNativeHistory(fresh.id, freshNativeId, 'new empty chat');
  check('new Codex chat materialized and reached ready without a model turn');

  const emptySeedId = await createUnpersistedThread();
  const messageSeedId = await createUnpersistedThread();
  report.ids.emptySeed = emptySeedId;
  report.ids.messageSeed = messageSeedId;
  await stopApp({ forceRuntime: true });
  await patchSeed(empty.id, emptySeedId);
  await patchSeed(withMessage.id, messageSeedId, { id: `${withMessage.id}:qa-seeded-user`, role: 'user', parts: [{ type: 'text', text: 'seeded local user message' }], createdAt: new Date().toISOString() });
  check('two exact probe-owned, unpersisted IDs were seeded only into the stopped isolated database');

  await startApp();
  const reopened = await presentAndWait(fresh.id, 'ready');
  assert.equal(reopened.nativeId, freshNativeId, 'materialized empty chat resumes with its original native ID');
  await assertEmptyTranscriptAndNativeHistory(fresh.id, freshNativeId, 'reopened empty chat');
  check('restart after runtime and Codex app-server shutdown preserves the same materialized native ID');

  const recovered = await presentAndWait(empty.id, 'ready');
  assert.match(recovered.nativeId ?? '', /^[0-9a-f-]{36}$/i, 'empty recovery has a new native ID');
  assert.notEqual(recovered.nativeId, emptySeedId, 'missing no-message chat replaces only its missing native ID');
  report.ids.emptyRecovered = recovered.nativeId;
  assert.equal((await rpc('runtime.snapshot')).sessions.find(session => session.id === empty.id)?.nativeId, recovered.nativeId, 'replacement native ID is stored durably');
  await assertEmptyTranscriptAndNativeHistory(empty.id, recovered.nativeId, 'recovered empty chat');
  check('missing native thread with no local messages recovers to a new ready native ID');

  const failed = await presentAndWait(withMessage.id, 'failed');
  assert.equal(failed.error?.code, 'native_resume_failed', `message-bearing chat keeps visible native_resume_failed: ${JSON.stringify(failed)}`);
  const failedScope = page.locator(`[data-testid="session-chat-${withMessage.id}"]`);
  const failureOverlay = failedScope.locator('.chat-reconnect-banner.is-failed, .chat-connect-mask.is-failed');
  await failureOverlay.waitFor({ state: 'visible' });
  assert.ok((await failureOverlay.innerText()).includes(failed.error.message), 'visible overlay shows the native resume error');
  assert.equal((await rpc('runtime.snapshot')).sessions.find(session => session.id === withMessage.id)?.nativeId, messageSeedId, 'message-bearing failure preserves its requested native ID');
  check('missing native thread with a local message remains visibly native_resume_failed');

  await stopApp();
  await startApp();
  const recoveredAgain = await presentAndWait(empty.id, 'ready');
  assert.equal(recoveredAgain.nativeId, recovered.nativeId, 'replacement native ID survives a second runtime restart');
  check('the replacement native ID is durable across a second restart');

  const beforePiCreate = (await piLaunches()).length;
  const piTerminal = await rpc('session.create', { projectId: project.id, cwd: workspace, provider: 'pi', mode: 'terminal', title: 'untouched Pi terminal', operationId: randomUUID() });
  const piNativeId = await until(async () => (await rpc('runtime.snapshot')).sessions.find(session => session.id === piTerminal.id)?.nativeId, 'Pi preassigned terminal id');
  await waitForPiLaunch(piTerminal.id, piNativeId, beforePiCreate);
  assert.deepEqual(await piJsonlFiles(piSessions), [], 'untouched Pi terminal wrote no native session JSONL');
  report.ids.piTerminal = piNativeId;
  await stopApp({ forceRuntime: true });
  await startApp();
  const beforePiResume = (await piLaunches()).length;
  const resumedPi = await rpc('session.resume', { sessionId: piTerminal.id, operationId: randomUUID() });
  assert.equal(resumedPi.id, piTerminal.id, 'Pi resume retains the ThreadTerm session');
  assert.equal(resumedPi.nativeId, piNativeId, 'Pi resume retains the native UUID');
  await waitForPiLaunch(piTerminal.id, piNativeId, beforePiResume);
  assert.deepEqual(await piJsonlFiles(piSessions), [], 'Pi resume without a turn still wrote no native session JSONL');
  check('untouched Pi terminal restart preserves its UUID and uses --session-id while no native JSONL exists');

  assert.deepEqual(report.errors, [], report.errors.join('\n'));
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  let stopped = true;
  try { await stopApp(); } catch (error) { stopped = false; report.errors.push(`process cleanup: ${error.message}`); }
  for (const server of nativeServers) {
    try { await terminateNative(server); } catch (error) { stopped = false; report.errors.push(`native cleanup: ${error.message}`); }
  }
  report.cleanup = {
    root: scratch,
    nativeIds: Object.values(report.ids),
    nativeArtifacts: (await readdir(codexHome, { recursive: true }).catch(() => [])).map(path => join(codexHome, path)),
    piArtifacts: (await readdir(piAgent, { recursive: true }).catch(() => [])).map(path => join(piAgent, path)),
    piSessionArtifacts: (await readdir(piSessions, { recursive: true }).catch(() => [])).map(path => join(piSessions, path)),
    removed: false,
  };
  if (stopped) await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).then(() => { report.cleanup.removed = true; }).catch(error => { report.errors.push(`scratch cleanup: ${error.message}`); });
  else report.errors.push(`scratch retained because process shutdown was not confirmed: ${scratch}`);
  if (report.errors.length) process.exitCode = 1;
  report.passed = report.passed && report.errors.length === 0;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(report.passed ? 'CHAT UNPERSISTED THREAD REAL QA PASSED' : `CHAT UNPERSISTED THREAD REAL QA FAILED\n${report.errors.join('\n')}`);
}

assert.equal(report.errors.length, 0, report.errors.join('\n'));
