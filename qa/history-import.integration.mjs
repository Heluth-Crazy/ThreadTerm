import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectPeer } from './pipe-client.mjs';

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const qaDirectory = dirname(fileURLToPath(import.meta.url));
const v3Root = resolve(qaDirectory, '..');
const runtimeExecutable = process.env.THREADTERM_V3_RUNTIME_BIN
  ?? resolve(v3Root, 'runtime/target/debug/threadterm-v3-runtime.exe');
const fixtureSource = resolve(qaDirectory, 'fixtures/fake-codex-app-server.mjs');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-v3-history-import-'));
const dataDirectory = join(scratch, 'data');
const workspace = join(scratch, 'workspace');
const providerHome = join(scratch, 'provider-home');
const fixtureBin = join(scratch, 'fixture-bin');
const fakeEventsDirectory = join(scratch, 'fake-events');
const fakeControlPath = join(scratch, 'fake-control.json');
const pipeBase = `\\\\.\\pipe\\threadterm-v3-history-import-${randomUUID()}`;
const resultPath = resolve(qaDirectory, 'results/history-import.integration.json');
const nativeId = `qa-native-${randomUUID()}`;
const failingNativeId = `qa-failing-${randomUUID()}`;
const result = {
  passed: false,
  runtimeExecutable,
  isolationRoot: scratch,
  pipeBase,
  runtimePids: [],
  fakeProviderPids: [],
  checks: [],
};

let daemon;
let daemonStderr = '';
let primaryPeer;
const peers = [];
let failure;

function assertScratchPath(target) {
  const relation = relative(resolve(tmpdir()), resolve(target));
  assert.ok(relation && !relation.startsWith('..') && !isAbsolute(relation), `unsafe scratch path: ${target}`);
}

async function writeControl(patch = {}) {
  const value = {
    cwd: workspace,
    nativeIds: [nativeId, failingNativeId],
    failResumeNativeIds: [],
    ...patch,
  };
  await writeFile(fakeControlPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function fakeEvents() {
  const events = [];
  for (const name of await readdir(fakeEventsDirectory)) {
    if (!name.endsWith('.jsonl')) continue;
    const content = await readFile(join(fakeEventsDirectory, name), 'utf8');
    for (const line of content.split(/\r?\n/u).filter(Boolean)) events.push(JSON.parse(line));
  }
  return events.sort((left, right) => (
    left.recordedAt - right.recordedAt
    || left.pid - right.pid
    || left.sequence - right.sequence
  ));
}

const eventKey = (event) => `${event.pid}:${event.sequence}`;
const eventsSince = (before, after) => {
  const prior = new Set(before.map(eventKey));
  return after.filter((event) => !prior.has(eventKey(event)));
};

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidState(pid, alive, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pidIsAlive(pid) === alive) return;
    await delay(25);
  }
  assert.equal(pidIsAlive(pid), alive, `${label}: PID ${pid} liveness did not become ${alive}`);
}

async function waitForEvent(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matching = (await fakeEvents()).filter(predicate);
    if (matching.length) return matching;
    await delay(25);
  }
  throw new Error(`timed out waiting for fake provider event: ${label}`);
}

function startDaemon() {
  assert.equal(daemon, undefined, 'a QA runtime is already assigned');
  daemonStderr = '';
  const overriddenNames = new Set([
    'path',
    'codex_home',
    'openai_api_key',
    'threadterm_v3_data',
    'threadterm_v3_pipe',
    'threadterm_qa_fake_codex_events',
    'threadterm_qa_fake_codex_control',
  ]);
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !overriddenNames.has(name.toLowerCase())),
  );
  childEnvironment.Path = [
    fixtureBin,
    dirname(process.execPath),
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
  ].join(';');
  childEnvironment.CODEX_HOME = providerHome;
  childEnvironment.THREADTERM_V3_DATA = dataDirectory;
  childEnvironment.THREADTERM_V3_PIPE = pipeBase;
  childEnvironment.THREADTERM_QA_FAKE_CODEX_EVENTS = fakeEventsDirectory;
  childEnvironment.THREADTERM_QA_FAKE_CODEX_CONTROL = fakeControlPath;
  daemon = spawn(runtimeExecutable, [], {
    cwd: fixtureBin,
    env: childEnvironment,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  result.runtimePids.push(daemon.pid);
  daemon.stderr.on('data', (bytes) => { daemonStderr += bytes; });
}

async function connectAuthenticatedPeer() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    let candidate;
    try {
      const credential = (await readFile(join(dataDirectory, 'runtime.credential'), 'utf8')).trim();
      candidate = await connectPeer(`${pipeBase}-control`);
      await candidate.auth(credential);
      peers.push(candidate);
      return candidate;
    } catch {
      candidate?.close();
      if (daemon?.exitCode !== null) {
        throw new Error(`isolated runtime exited ${daemon?.exitCode}: ${daemonStderr}`);
      }
      await delay(50);
    }
  }
  throw new Error(`isolated runtime startup timed out: ${daemonStderr}`);
}

async function shutdownDaemon(peer) {
  if (!daemon || daemon.exitCode !== null) return;
  const ownedDaemon = daemon;
  await peer.request('runtime.shutdown', { operationId: randomUUID() });
  peer.close();
  await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(
      () => rejectExit(new Error(`runtime PID ${ownedDaemon.pid} did not shut down`)),
      10_000,
    );
    ownedDaemon.once('exit', () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
  daemon = undefined;
}

async function importHistory(peer, selectedNativeId, operationId = randomUUID(), cwd = workspace) {
  return peer.request('history.import', {
    provider: 'codex',
    nativeId: selectedNativeId,
    cwd,
    mode: 'chat',
    title: `Imported ${selectedNativeId}`,
    operationId,
  });
}

async function snapshotSession(peer, sessionId) {
  const snapshot = await peer.request('runtime.snapshot', {});
  return snapshot.sessions.find((session) => session.id === sessionId);
}

async function claimAndAssertReadOnly(peer, session) {
  const lease = await peer.request('session.claim', { sessionId: session.id, clientId: 'ignored' });
  for (const [method, params] of [
    ['terminal.input', { sessionId: session.id, data: 'forbidden\r\n', leaseEpoch: lease.leaseEpoch }],
    ['chat.send', {
      sessionId: session.id,
      text: 'forbidden',
      leaseEpoch: lease.leaseEpoch,
      operationId: randomUUID(),
    }],
  ]) {
    await assert.rejects(
      peer.request(method, params),
      (error) => ['invalid_request', 'session_read_only_resume_required'].includes(error.code) && /read.only.*resume.required/iu.test(error.message),
    );
  }
  await peer.request('session.release', {
    sessionId: session.id,
    leaseEpoch: lease.leaseEpoch,
  });
}

try {
  assertScratchPath(scratch);
  await Promise.all([
    mkdir(dataDirectory),
    mkdir(workspace),
    mkdir(providerHome),
    mkdir(fixtureBin),
    mkdir(fakeEventsDirectory),
    mkdir(dirname(resultPath), { recursive: true }),
  ]);
  await writeControl();
  await copyFile(process.execPath, join(fixtureBin, 'codex.exe'));
  await writeFile(join(fixtureBin, 'app-server'), [
    `'use strict';`,
    `import(${JSON.stringify(pathToFileURL(fixtureSource).href)}).catch((error) => {`,
    `  process.stderr.write(String(error?.stack ?? error));`,
    `  process.exitCode = 5;`,
    `});`,
    '',
  ].join('\n'));

  startDaemon();
  primaryPeer = await connectAuthenticatedPeer();

  const beforeInitialImport = await fakeEvents();
  const imported = await importHistory(primaryPeer, nativeId);
  assert.equal(imported.readOnly, true);
  assert.equal(imported.status, 'idle');
  assert.equal(imported.nativeId, nativeId);
  const importedTranscript = await primaryPeer.request('chat.read', { sessionId: imported.id });
  assert.equal(importedTranscript.length, 2);
  const initialEvents = eventsSince(beforeInitialImport, await fakeEvents());
  assert.equal(initialEvents.filter((event) => event.event === 'historyRead').length, 1);
  assert.equal(initialEvents.some((event) => event.event === 'interactiveResume'), false);
  assert.equal(initialEvents.some((event) => event.event === 'unexpectedThreadStart'), false);
  const initialHelperPid = initialEvents.find((event) => event.event === 'spawn')?.pid;
  assert.ok(Number.isSafeInteger(initialHelperPid));
  await waitForPidState(initialHelperPid, false, 'history import helper exited');
  result.checks.push('history.import captured the fixture transcript without starting or retaining an interactive provider worker');

  await claimAndAssertReadOnly(primaryPeer, imported);
  assert.deepEqual(await primaryPeer.request('chat.read', { sessionId: imported.id }), importedTranscript);
  result.checks.push('read-only import rejected terminal.input and chat.send after a valid lease');

  await shutdownDaemon(primaryPeer);
  primaryPeer.close();
  startDaemon();
  primaryPeer = await connectAuthenticatedPeer();
  const persisted = await snapshotSession(primaryPeer, imported.id);
  assert.equal(persisted.readOnly, true);
  assert.equal(persisted.status, 'idle');
  assert.equal(persisted.nativeId, nativeId);
  assert.deepEqual(await primaryPeer.request('chat.read', { sessionId: imported.id }), importedTranscript);

  const eventsBeforeDuplicate = await fakeEvents();
  const duplicate = await importHistory(
    primaryPeer,
    nativeId,
    randomUUID(),
    join(scratch, 'intentionally-missing-relocation'),
  );
  assert.equal(duplicate.id, imported.id);
  assert.equal((await fakeEvents()).length, eventsBeforeDuplicate.length);
  result.checks.push('restart preserved the read-only transcript and duplicate native-owner import reused it without cwd access or a provider helper');

  const eventsBeforeResume = await fakeEvents();
  const resumed = await primaryPeer.request('session.resume', {
    sessionId: imported.id,
    cwd: workspace,
    operationId: randomUUID(),
  });
  assert.equal(resumed.id, imported.id);
  assert.equal(resumed.nativeId, nativeId);
  assert.notEqual(resumed.readOnly, true);
  await waitForEvent(
    (event) => event.event === 'interactiveResume' && event.nativeId === nativeId,
    'successful explicit resume',
  );
  const resumeEvents = eventsSince(eventsBeforeResume, await fakeEvents())
    .filter((event) => event.event === 'interactiveResume' && event.nativeId === nativeId);
  const firstInteractive = resumeEvents.at(-1);
  assert.ok(firstInteractive);
  await waitForPidState(firstInteractive.pid, true, 'explicit resume worker alive');
  assert.equal((await snapshotSession(primaryPeer, imported.id)).readOnly, undefined);
  assert.deepEqual(await primaryPeer.request('chat.read', { sessionId: imported.id }), importedTranscript);
  result.fakeProviderPids.push(firstInteractive.pid);
  result.checks.push('explicit session.resume preserved session/native identity, cleared read-only, and left one local fake CLI worker alive');
  const statusLease = await primaryPeer.request('session.claim', {
    sessionId: resumed.id,
    clientId: 'ignored',
  });
  const statusOperationId = randomUUID();
  const eventsBeforeStatus = await fakeEvents();
  const inboxBeforeStatus = (await primaryPeer.request('runtime.snapshot'))
    .inbox.filter((item) => item.sessionId === resumed.id).map((item) => item.id);
  await delay(100);
  const statusResult = await primaryPeer.request('chat.send', {
    sessionId: resumed.id,
    text: '/status',
    operationId: statusOperationId,
    leaseEpoch: statusLease.leaseEpoch,
  });
  assert.deepEqual(statusResult, { turnId: statusOperationId });
  let statusItems = [];
  const statusDeadline = Date.now() + 5_000;
  while (Date.now() < statusDeadline) {
    statusItems = await primaryPeer.request('chat.read', { sessionId: resumed.id });
    if (statusItems.some((item) => {
      if (item.turnId !== statusOperationId || item.role !== 'assistant') return false;
      const part = item.parts?.find((candidate) => candidate.type === 'status');
      return part?.data?.accountLoaded === true
        && part.data.account?.type === 'chatgpt'
        && part.data.rateLimits?.length === 2;
    })) break;
    await delay(25);
  }
  const statusAssistant = statusItems.find(
    (item) => item.turnId === statusOperationId && item.role === 'assistant',
  );
  assert.ok(statusAssistant, 'status did not create an assistant chat item');
  const statusPart = statusAssistant.parts.find((part) => part.type === 'status');
  assert.ok(statusPart, 'status did not create a structured status part');
  assert.match(statusPart.text ?? '', /Codex session status/u);
  assert.equal(statusPart.data?.cliVersion, 'codex-qa-fixture 1.0.0');
  assert.equal(statusPart.data?.model, 'gpt-5.5-luna');
  assert.equal(statusPart.data?.thread?.name, `QA history ${nativeId}`);
  assert.equal(statusPart.data?.instructionSources?.length, 1);
  assert.equal(statusPart.data?.account?.planType, 'prolite');
  assert.equal(statusPart.data?.accountLoaded, true);
  assert.equal(String(statusPart.data?.warning ?? '').includes('OpenAI authentication required'), false);
  assert.equal(statusPart.data?.rateLimits?.length, 2);
  assert.equal(statusPart.data?.context?.modelContextWindow, 258_000);
  assert.equal(statusPart.data?.context?.remainingTokens, 163_300);
  assert.ok(statusPart.data?.context?.percentUsed > 66 && statusPart.data?.context?.percentUsed < 67);
  assert.equal((await snapshotSession(primaryPeer, resumed.id)).status, 'idle');
  const inboxAfterStatus = (await primaryPeer.request('runtime.snapshot'))
    .inbox.filter((item) => item.sessionId === resumed.id).map((item) => item.id);
  assert.deepEqual(inboxAfterStatus, inboxBeforeStatus);
  const statusEvents = eventsSince(eventsBeforeStatus, await fakeEvents());
  assert.equal(statusEvents.some((event) => event.event === 'request' && event.method === 'turn/start'), false);
  result.checks.push('chat.send /status returned the strict turn contract, projected a local assistant status item, kept the session idle, and did not start a provider turn');
  const usageOperationId = randomUUID();
  const beforeUsage = await fakeEvents();
  assert.deepEqual(await primaryPeer.request('chat.send', {
    sessionId: resumed.id, text: '/usage', operationId: usageOperationId, leaseEpoch: statusLease.leaseEpoch,
  }), { turnId: usageOperationId });
  let usagePart;
  for (let attempt = 0; attempt < 100; attempt++) {
    const messages = await primaryPeer.request('chat.read', { sessionId: resumed.id });
    usagePart = messages.find(item => item.turnId === usageOperationId && item.role === 'assistant')?.parts.find(part => part.type === 'status');
    if (usagePart?.data?.rateLimits?.length === 2) break;
    await delay(25);
  }
  assert.equal(usagePart?.data?.rateLimits?.length, 2);
  assert.equal(usagePart?.data?.context?.modelContextWindow, 258_000);
  assert.equal(eventsSince(beforeUsage, await fakeEvents()).some(event => event.event === 'request' && event.method === 'turn/start'), false, '/usage must not be sent to the model');
  result.checks.push('/usage resolves locally with real projected usage and does not start a model turn');
  await primaryPeer.request('session.stop', { sessionId: imported.id, operationId: randomUUID() });
  await waitForPidState(firstInteractive.pid, false, 'stopped explicit resume worker');

  const failedImport = await importHistory(primaryPeer, failingNativeId);
  const failedTranscript = await primaryPeer.request('chat.read', { sessionId: failedImport.id });
  await writeControl({ failResumeNativeIds: [failingNativeId] });
  await assert.rejects(
    primaryPeer.request('session.resume', {
      sessionId: failedImport.id,
      cwd: workspace,
      operationId: randomUUID(),
    }),
    /intentional QA resume failure/u,
  );
  const failedAfterResume = await snapshotSession(primaryPeer, failedImport.id);
  assert.equal(failedAfterResume.readOnly, true);
  assert.equal(failedAfterResume.status, 'idle');
  assert.equal(failedAfterResume.nativeId, failingNativeId);
  assert.deepEqual(await primaryPeer.request('chat.read', { sessionId: failedImport.id }), failedTranscript);
  const rejectedResume = (await fakeEvents()).find(
    (event) => event.event === 'resumeRejected' && event.nativeId === failingNativeId,
  );
  assert.ok(rejectedResume);
  await waitForPidState(rejectedResume.pid, false, 'failed resume worker exited');
  result.fakeProviderPids.push(rejectedResume.pid);
  result.checks.push('failed provider resume restored the original read-only status and transcript');

  await writeControl({ historyDelayMs: 300 });
  const contenderA = await connectAuthenticatedPeer();
  const contenderB = await connectAuthenticatedPeer();
  const eventsBeforeRace = await fakeEvents();
  const race = await Promise.allSettled([
    contenderA.request('session.resume', {
      sessionId: imported.id,
      cwd: workspace,
      operationId: randomUUID(),
    }, 20_000),
    contenderB.request('session.resume', {
      sessionId: imported.id,
      cwd: workspace,
      operationId: randomUUID(),
    }, 20_000),
  ]);
  await writeControl();
  assert.equal(race.filter((entry) => entry.status === 'fulfilled').length, 1);
  const loser = race.find((entry) => entry.status === 'rejected');
  assert.ok(loser && /session_already_active/u.test(loser.reason.message));
  const raceEvents = eventsSince(eventsBeforeRace, await fakeEvents());
  assert.equal(
    raceEvents.filter(
      (event) => event.event === 'historyRead' && event.nativeId === nativeId,
    ).length,
    1,
  );
  const raceWorkers = raceEvents.filter(
    (event) => event.event === 'interactiveResume' && event.nativeId === nativeId,
  );
  assert.equal(raceWorkers.length, 1);
  await waitForPidState(raceWorkers[0].pid, true, 'winning concurrent resume worker alive');
  assert.notEqual((await snapshotSession(primaryPeer, imported.id)).readOnly, true);
  result.fakeProviderPids.push(raceWorkers[0].pid);
  result.checks.push('two simultaneous named-pipe resumes serialized to one history read, one success, one rejection, and one surviving fake CLI worker');
  await primaryPeer.request('session.stop', { sessionId: imported.id, operationId: randomUUID() });
  await waitForPidState(raceWorkers[0].pid, false, 'winning concurrent resume worker stopped');

  const allEvents = await fakeEvents();
  assert.equal(allEvents.some((event) => event.event === 'unexpectedInvocation'), false);
  assert.equal(allEvents.some((event) => event.event === 'unexpectedThreadStart'), false);
  assert.equal(allEvents.some((event) => event.event === 'fixtureError'), false);
  result.fakeProviderPids = [...new Set([
    ...result.fakeProviderPids,
    ...allEvents.filter((event) => event.event === 'spawn').map((event) => event.pid),
  ])];

  await shutdownDaemon(primaryPeer);
  for (const pid of result.fakeProviderPids) await waitForPidState(pid, false, 'runtime shutdown provider cleanup');
  result.checks.push('authenticated runtime.shutdown exited every isolated runtime and fake provider process');
  result.passed = true;
} catch (error) {
  failure = error;
  result.error = error instanceof Error ? error.message : String(error);
  result.diagnostic = daemonStderr.slice(-4_000);
  result.fakeEvents = await fakeEvents().catch(() => []);
} finally {
  if (daemon && daemon.exitCode === null && primaryPeer) {
    try {
      await shutdownDaemon(primaryPeer);
    } catch (error) {
      result.cleanupError = error instanceof Error ? error.message : String(error);
    }
  }
  for (const peer of peers) peer.close();
  if (daemon && daemon.exitCode === null) {
    daemon.kill();
    await Promise.race([
      new Promise((resolveExit) => daemon.once('exit', resolveExit)),
      delay(5_000),
    ]);
  }
  assertScratchPath(scratch);
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  result.cleanedIsolationRoot = true;
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

console.log(JSON.stringify(result, null, 2));
if (failure) throw failure;
