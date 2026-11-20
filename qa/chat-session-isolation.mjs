// Production Desktop RuntimeClient + real runtime + local Codex fixture.
// Proves a slow chat.connect for A cannot queue ready session B's send or its
// chat.item delivery. Results: qa/results/chat-session-isolation/<run-id>.json.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { aggregateTrace, parseTrace } from './lib/send-latency-breakdown.mjs';
import { removeScratch } from './lib/qa-cleanup.mjs';
import { electron } from './lib/desktop1.mjs';
import { buildQaApp } from './lib/qa-app.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';
import { connectPeer } from './pipe-client.mjs';
import { PROTOCOL_CONTRACT } from '../protocol/index.ts';

const option = (name, fallback) => {
  const equals = process.argv.find(value => value.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
if (process.argv.includes('--help')) {
  console.log('node qa/chat-session-isolation.mjs --runtime <exe> [--slow-ms 5000] [--keep]\n'
    + 'Builds the production desktop into Temp and writes qa/results/chat-session-isolation/<run-id>.json.');
  process.exit(0);
}

assert.equal(process.platform, 'win32', 'This production desktop probe requires Windows');
const root = resolve(import.meta.dirname, '..');
const runtime = resolve(option('--runtime', 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const fixture = join(root, 'qa/fixtures/slow-session-provider.cjs');
const slowMs = Number(option('--slow-ms', '5000'));
const keep = process.argv.includes('--keep');
assert.ok(existsSync(runtime), `Missing runtime: ${runtime}`);
assert.ok(existsSync(fixture), `Missing fixture: ${fixture}`);
assert.ok(Number.isFinite(slowMs) && slowMs >= 2000 && slowMs <= 30_000, '--slow-ms must be 2000..30000');

const scratch = await mkdtemp(join(tmpdir(), 'tt-chat-session-isolation-'));
const bin = join(scratch, 'bin');
const workspace = join(scratch, 'workspace');
const aWorkspace = join(workspace, 'a-slow');
const bWorkspace = join(workspace, 'b-ready');
const control = join(scratch, 'control');
const data = join(scratch, 'data');
const profile = join(scratch, 'profile');
const providerLog = join(scratch, 'provider.jsonl');
const out = join(root, 'qa/results/chat-session-isolation');
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const reportPath = join(out, `${runId}.json`);
const blocked = /^(path$|home$|userprofile$|appdata$|localappdata$|temp$|tmp$|threadterm_|tt_qa_|codex|openai_|electron_|node_options$|git_)/iu;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.test(key)));
const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
Object.assign(env, {
  PATH: [bin, dirname(process.execPath), system32].join(';'),
  HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
  APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'),
  TEMP: join(scratch, 'tmp'), TMP: join(scratch, 'tmp'), CODEX_HOME: join(scratch, 'codex-home'),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'empty.gitconfig'), GIT_TERMINAL_PROMPT: '0',
  THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: profile,
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-chat-session-isolation-${randomUUID()}`,
  THREADTERM_V3_RUNTIME: runtime, THREADTERM_QA_PROVIDER_BIN: bin,
  THREADTERM_V3_SEND_TRACE: '1',
  TT_QA_NODE: process.execPath, TT_QA_SCRIPT: fixture,
  THREADTERM_QA_SLOW_SESSION_CONTROL: control,
  THREADTERM_QA_SLOW_SESSION_LOG: providerLog,
  THREADTERM_QA_SLOW_SESSION_CWD: workspace,
  THREADTERM_QA_SLOW_SESSION_TARGET_CWD: aWorkspace,
});
assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['PATH']);

const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const pathKey = value => {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
const until = async (probe, label, timeout = 45_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(40);
  }
  throw new Error(`Timed out: ${label}`);
};
const providerRows = async () => (await readFile(providerLog, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const readTrace = async () => parseTrace((await Promise.all([
  readFile(join(data, 'runtime.log'), 'utf8').catch(() => ''),
  readFile(join(data, 'desktop-send-trace.log'), 'utf8').catch(() => ''),
])).join('\n'));

const report = {
  schema: 1, runId, passed: false, runtime, fixture, slowMs,
  assertion: 'B send, assistant event, and ChatView render must finish inside A cwd-scoped thread startup delay.',
  timeline: [], scratch: keep ? scratch : undefined,
};
const started = performance.now();
const startedWall = Date.now();
const elapsed = () => Math.round(performance.now() - started);
const note = (name, detail = {}) => {
  const row = { ms: elapsed(), name, ...detail };
  report.timeline.push(row);
  console.log(JSON.stringify(row));
  return row.ms;
};

let app;
let page;
let releaseLock;
let cleanupApp = async () => {};
let bOperationId;
let scenarioError;
const rpc = (method, params = {}) => page.evaluate(([requestMethod, requestParams]) =>
  window.threadterm.request(requestMethod, requestParams), [method, params]);
const captureSendTrace = async () => {
  const rows = await readTrace();
  report.traceRows = rows;
  if (!bOperationId) return undefined;
  try {
    const trace = aggregateTrace(rows, { operationId: bOperationId, strictSend: false, expectStdin: true });
    report.sendTrace = {
      operationId: bOperationId, requestId: trace.requestId, metrics: trace.metrics,
      activeAhead: trace.activeAhead, git: trace.git, missing: trace.missing, rows: trace.rows,
    };
    delete report.sendTraceCaptureError;
    return trace;
  } catch (error) {
    report.sendTraceCaptureError = error instanceof Error ? error.message : String(error);
    return undefined;
  }
};

try {
  await Promise.all([bin, workspace, aWorkspace, bWorkspace, control, data, profile, out,
    env.HOME, env.APPDATA, env.LOCALAPPDATA, env.TEMP, env.CODEX_HOME]
    .map(path => mkdir(path, { recursive: true })));
  await writeFile(providerLog, '');
  await writeFile(join(control, 'thread-ms'), '0');
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);

  const built = await buildQaApp({ root });
  cleanupApp = built.cleanup;
  releaseLock = await acquireElectronQaLock();
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', built.appDir], cwd: bin, env, timeout: 90_000 });
  page = await app.firstWindow({ timeout: 60_000 });
  page.setDefaultTimeout(45_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 60_000 });

  // Compatibility is a hard prerequisite, not a fallback observation. The
  // same current protocol validators used by other pipe QA validate both
  // responses before the desktop cross-session scenario begins.
  const auxiliary = await until(async () => {
    let candidate;
    try {
      const credential = (await readFile(join(data, 'runtime.credential'), 'utf8')).trim();
      candidate = await connectPeer(`${env.THREADTERM_V3_PIPE}-control`);
      const clientId = await candidate.auth(credential);
      return { peer: candidate, clientId };
    } catch {
      candidate?.close();
      return undefined;
    }
  }, 'authenticated auxiliary control pipe');
  try {
    const filter = await auxiliary.peer.request('runtime.events.filter', { preset: 'none' });
    assert.deepEqual(filter, { preset: 'none' }, 'Runtime must explicitly accept request-only event filtering');
    const health = await auxiliary.peer.request('runtime.health');
    assert.equal(health.contract, PROTOCOL_CONTRACT, 'Auxiliary pipe/runtime protocol contract mismatch');
    assert.equal(typeof health.epoch, 'string');
    report.auxiliaryHandshake = { clientId: auxiliary.clientId, filter, health };
    note('strict auxiliary handshake passed', { epoch: health.epoch, contract: health.contract });
  } finally {
    auxiliary.peer.close();
  }

  const health = await rpc('runtime.health');
  assert.equal(health.contract, PROTOCOL_CONTRACT, 'Production desktop bridge/runtime protocol contract mismatch');
  assert.equal(health.epoch, report.auxiliaryHandshake.health.epoch, 'Desktop and auxiliary pipes reached different runtimes');
  note('production desktop route ready');

  const project = await rpc('project.add', { path: workspace, name: 'Chat session isolation QA', operationId: randomUUID() });
  const create = (title, cwd) => rpc('session.create', { projectId: project.id, cwd, provider: 'codex', mode: 'chat', title, operationId: randomUUID() });
  const b = await create('B ready send', bWorkspace);
  const a = await create('A slow connect', aWorkspace);
  const bLease = await rpc('session.claim', { sessionId: b.id, clientId: 'chat-session-isolation-qa' });
  await rpc('chat.connect', { sessionId: b.id, leaseEpoch: bLease.leaseEpoch, operationId: randomUUID() });
  await rpc('session.present', { sessionId: b.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await app.evaluate(({ BrowserWindow }, sessionId) => BrowserWindow.getAllWindows()[0].webContents
    .send('threadterm:desktop-navigate', { sessionId }), b.id);
  const bChat = page.locator(`[data-testid="session-chat-${b.id}"]`);
  await bChat.waitFor({ state: 'visible' });
  await until(async () => {
    const [connection, snapshot] = await Promise.all([rpc('chat.connection', { sessionId: b.id }), rpc('runtime.snapshot')]);
    return connection.phase === 'ready' && snapshot.sessions.find(value => value.id === b.id)?.status === 'idle';
  }, 'B ready and idle');
  const bRuntimeSession = (await rpc('runtime.snapshot')).sessions.find(value => value.id === b.id);
  assert.equal(typeof bRuntimeSession.nativeId, 'string', 'B did not receive a native identity');
  const bNativeId = bRuntimeSession.nativeId;
  const bProviderStart = (await providerRows()).find(row => row.direction === 'delay'
    && row.method === 'thread/start' && row.nativeId === bNativeId);
  assert.ok(bProviderStart, 'B provider thread/start was not observed');
  assert.equal(pathKey(bProviderStart.cwd), pathKey(bWorkspace), 'B provider did not receive its dedicated cwd');
  assert.equal(bProviderStart.target, false, 'B provider startup was incorrectly marked as the slow target');
  assert.equal(bProviderStart.ms, 0, 'B provider startup must not be delayed');
  const bBaseline = await rpc('chat.snapshot', { sessionId: b.id });
  const baselineIds = bBaseline.items.map(item => item.id);
  await page.evaluate(({ sessionId, wallOrigin }) => {
    window.__chatSessionIsolation = { sessionId, wallOrigin, items: [] };
    window.__chatSessionIsolation.unsubscribe = window.threadterm.onEvent(event => {
      const data = event?.data;
      if (event?.event !== 'chat.item' || data?.sessionId !== sessionId || !data.item) return;
      const item = data.item;
      window.__chatSessionIsolation.items.push({
        wall: Date.now(), seq: event.seq, id: item.id, turnId: item.turnId, role: item.role,
        text: (item.parts ?? []).map(part => part.text ?? '').join('\n'),
      });
    });
  }, { sessionId: b.id, wallOrigin: startedWall });
  note('B ready and subscribed', { sessionId: b.id });

  await writeFile(join(control, 'thread-ms'), String(slowMs));
  const logStart = (await providerRows()).length;
  const aLease = await rpc('session.claim', { sessionId: a.id, clientId: 'chat-session-isolation-qa' });
  let aSettled;
  const aStartedMs = note('A connect requested', { sessionId: a.id });
  const aOutcome = rpc('chat.connect', { sessionId: a.id, leaseEpoch: aLease.leaseEpoch, operationId: randomUUID() })
    .then(value => ({ ok: true, value, ms: elapsed() }), error => ({ ok: false, error: String(error?.stack ?? error), ms: elapsed() }))
    .then(outcome => { aSettled = outcome; return outcome; });
  const aDelay = await until(async () => (await providerRows()).slice(logStart)
    .find(row => row.direction === 'delay' && ['thread/start', 'thread/resume'].includes(row.method)
      && row.ms === slowMs && row.target === true && pathKey(row.cwd) === pathKey(aWorkspace)),
  'A entered cwd-scoped fake-provider thread delay');
  await delay(100);
  assert.equal(aSettled, undefined, 'A chat.connect settled before its configured provider delay elapsed');
  assert.notEqual(aDelay.nativeId, bNativeId, 'A delay was incorrectly attributed to B native identity');
  assert.equal((await readFile(join(control, 'target-native-id'), 'utf8')).trim(), aDelay.nativeId,
    'Fixture target-native marker did not match A delayed startup');
  const aWaitingMs = note('A connect confirmed waiting', {
    providerPid: aDelay.pid, instanceId: aDelay.instanceId, requestId: aDelay.requestId,
    cwd: aDelay.cwd, nativeId: aDelay.nativeId,
  });

  const currentBLease = await rpc('session.claim', { sessionId: b.id, clientId: 'chat-session-isolation-qa' });
  bOperationId = randomUUID();
  const prompt = `chat session isolation ${bOperationId}`;
  const bSendStartedMs = note('B send requested', { sessionId: b.id, operationId: bOperationId });
  let sendResult;
  let sendFailure;
  try {
    sendResult = await rpc('chat.send', { sessionId: b.id, text: prompt, leaseEpoch: currentBLease.leaseEpoch, operationId: bOperationId });
  } catch (error) {
    sendFailure = error;
  } finally {
    report.sendError = sendFailure instanceof Error ? sendFailure.stack : sendFailure ? String(sendFailure) : undefined;
    report.sendResult = sendResult;
    note(sendFailure ? 'B send failed' : 'B send succeeded');
    // Capture before any isolation assertion so a regression still leaves its
    // correlated queue/service/checkpoint evidence in the report.
    await until(async () => {
      const trace = await captureSendTrace();
      const stages = new Set(trace?.rows.map(row => `${row.source}:${row.stage}`));
      return stages.has('desktop:desktop.request.end') && stages.has('runtime:transport.dispatch.end') ? trace : undefined;
    }, 'B send trace flush', 10_000).catch(async error => {
      report.sendTraceFlushError = error instanceof Error ? error.message : String(error);
      await captureSendTrace();
    });
  }
  const bSendResolvedMs = report.timeline.at(-1).ms;
  assert.equal(sendFailure, undefined, `B chat.send failed: ${report.sendError ?? ''}`);
  assert.equal(aSettled, undefined, 'A completed before B chat.send succeeded');

  const bEvent = await until(async () => page.evaluate(baseline => {
    const known = new Set(baseline);
    return window.__chatSessionIsolation?.items.find(item => item.role === 'assistant'
      && !known.has(item.id) && item.text.includes('SESSION-ISOLATION-ANSWER'));
  }, baselineIds), 'new B assistant chat.item event');
  const bEventMs = bEvent.wall - startedWall;
  note('B chat.item reached subscription', { itemId: bEvent.id, seq: bEvent.seq, eventMs: bEventMs });
  assert.equal(aSettled, undefined, 'A completed before B chat.item reached the event subscription');

  await until(() => bChat.evaluate((element, itemId) => [...element.querySelectorAll('[data-chat-item]')]
    .some(node => node.dataset.chatItem === itemId && (node.textContent ?? '').includes('SESSION-ISOLATION-ANSWER')), bEvent.id),
  'new B item rendered in ChatView');
  const bUiMs = note('B chat.item rendered in UI', { itemId: bEvent.id });
  assert.equal(aSettled, undefined, 'A completed before B chat.item rendered');

  const firstDelayEnd = await until(async () => (await providerRows()).slice(logStart)
    .find(row => row.direction === 'delay_end' && row.instanceId === aDelay.instanceId
      && row.requestId === aDelay.requestId && row.method === aDelay.method), 'A cwd-scoped thread delay completed');
  const firstDelayEndMs = firstDelayEnd.at - startedWall;
  assert.ok(bSendResolvedMs < firstDelayEndMs && bEventMs < firstDelayEndMs && bUiMs < firstDelayEndMs,
    `B did not finish inside A cwd-scoped thread delay: send/event/UI ${bSendResolvedMs}/${bEventMs}/${bUiMs} ms, delay end ${firstDelayEndMs} ms`);

  const aResult = await aOutcome;
  assert.equal(aResult.ok, true, `A fixture/connect failed instead of completing: ${aResult.error ?? ''}`);
  assert.equal(aResult.value?.phase, 'ready', 'A chat.connect did not return ready');
  const aConnection = await rpc('chat.connection', { sessionId: a.id });
  assert.equal(aConnection.phase, 'ready', 'A canonical connection was not ready after connect returned');
  const aCompletedMs = note('A connect completed', { phase: aConnection.phase });

  const startupRows = (await providerRows()).slice(logStart);
  const bHistoryReads = startupRows.filter(row => row.direction === 'in'
    && row.method === 'thread/read' && row.threadId === bNativeId);
  assert.equal(startupRows.find(row => row.direction === 'delay' && ['initialize', 'thread/read'].includes(row.method)), undefined,
    'Fixture must never delay initialize or history reads');
  assert.equal(startupRows.find(row => row.direction === 'delay' && row.ms > 0
    && !(row.target === true && pathKey(row.cwd) === pathKey(aWorkspace) && row.nativeId === aDelay.nativeId)), undefined,
  'A dedicated cwd/native identity must be the only delayed provider request');
  const slowWindows = startupRows.filter(row => row.direction === 'delay' && row.ms === slowMs).map(begin => {
    const end = startupRows.find(row => row.direction === 'delay_end' && row.instanceId === begin.instanceId
      && row.requestId === begin.requestId && row.method === begin.method && row.at >= begin.at);
    return { instanceId: begin.instanceId, pid: begin.pid, requestId: begin.requestId, method: begin.method,
      startedAt: begin.at, endedAt: end?.at ?? null, observedMs: end ? end.at - begin.at : null };
  });
  assert.equal(slowWindows.find(window => window.endedAt === null), undefined, 'A fixture left an incomplete delay window');
  assert.equal(slowWindows.find(window => window.observedMs < slowMs - 50), undefined, 'A fixture delay finished too early');
  const phasesAt = wall => slowWindows.filter(window => window.startedAt <= wall && wall <= window.endedAt)
    .map(window => ({ instanceId: window.instanceId, pid: window.pid, method: window.method }));
  report.providerStartup = {
    target: { sessionId: a.id, cwd: aWorkspace, nativeId: aDelay.nativeId },
    readySession: {
      sessionId: b.id, cwd: bWorkspace, nativeId: bNativeId,
      providerStart: bProviderStart, historyReadsDuringAConnect: bHistoryReads,
    },
    targetDelay: aDelay, slowWindows,
    bOverlap: {
      sendStarted: phasesAt(startedWall + bSendStartedMs),
      sendResolved: phasesAt(startedWall + bSendResolvedMs),
      itemEvent: phasesAt(startedWall + bEventMs),
      uiRendered: phasesAt(startedWall + bUiMs),
    },
  };
  Object.assign(report, {
    passed: true, sessions: { a: a.id, b: b.id },
    timings: { aStartedMs, aWaitingMs, bSendStartedMs, bSendResolvedMs, bEventMs, bUiMs, firstDelayEndMs, aCompletedMs },
  });
} catch (error) {
  scenarioError = error;
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  // Preserve evidence even when send, event, DOM, or timing assertions fail.
  await captureSendTrace().catch(error => { report.finalTraceError = error instanceof Error ? error.message : String(error); });
  report.providerRows = await providerRows().catch(() => []);
  if (scenarioError && page) await page.screenshot({ path: join(out, `${runId}-failure.png`) }).catch(() => {});
  if (page) {
    await page.evaluate(() => window.__chatSessionIsolation?.unsubscribe?.()).catch(() => {});
    await rpc('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  }
  await app?.close().catch(() => {});
  await cleanupApp().catch(() => {});
  await releaseLock?.();
  report.completedAt = new Date().toISOString();
  await mkdir(out, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${reportPath}; passed=${report.passed}`);
  if (report.error) console.error(report.error);
  if (!keep) await removeScratch(scratch).catch(error => console.error(`Retained scratch after cleanup failure: ${error.message}`));
}
