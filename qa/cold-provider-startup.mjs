// Desktop-1 production-path QA for a cold provider capability probe that takes
// longer than the desktop request timeout. The fake Kimi executable is held at
// ACP initialize; all homes, profiles, runtime data, pipes and PATH entries are
// isolated. This test never invokes an installed provider or account.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { electron } from './lib/desktop1.mjs';
import { connectPeer } from './pipe-client.mjs';
import { PROTOCOL_CONTRACT } from '../protocol/index.ts';

assert.equal(process.platform, 'win32', 'Desktop-1 QA requires Windows');
const option = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const root = resolve(import.meta.dirname, '..');
const runtime = resolve(option('--runtime') ?? process.env.THREADTERM_V3_RUNTIME_BIN
  ?? join(root, 'runtime', 'target-qa', 'debug', 'threadterm-v3-runtime.exe'));
assert.ok(existsSync(runtime), `missing runtime ${runtime}`);
const runtimeSha256 = createHash('sha256').update(await readFile(runtime)).digest('hex');
const keep = process.argv.includes('--keep');
process.env.TT_QA_DESKTOP = '1';
const evidenceDir = join(root, 'qa', 'results', 'cold-provider-startup');
const reportPath = join(evidenceDir, 'report.json');
const pendingScreenshotPath = join(evidenceDir, 'pending.png');
const confirmedScreenshotPath = join(evidenceDir, 'confirmed.png');

const scratch = await mkdtemp(join(tmpdir(), 'tt-cold-provider-'));
const bin = join(scratch, 'bin');
const data = join(scratch, 'data');
const profile = join(scratch, 'profile');
const home = join(scratch, 'home');
const appData = join(scratch, 'appdata');
const localAppData = join(scratch, 'localappdata');
const temp = join(scratch, 'temp');
const logFile = join(scratch, 'kimi.jsonl');
const gateFile = join(scratch, 'kimi.gate');
const pipe = `\\\\.\\pipe\\tt-cold-provider-${randomUUID()}`;
const fixture = join(root, 'qa', 'fixtures', 'fake-kimi-cold-start.mjs');
let app;
let page;
let cleanupError;
const pageErrors = [];
const report = { passed: false, runtime, runtimeSha256, checks: [], timingsMs: {}, errors: [] };

const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
async function until(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(40);
  }
  throw new Error(`Timed out: ${label}`);
}
async function fixtureRows() {
  const raw = await readFile(logFile, 'utf8').catch(() => '');
  return raw.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}
function isolatedEnvironment() {
  const filtered = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(path|home|userprofile|appdata|localappdata|temp|tmp|threadterm_|codex|claude|grok|kimi|gemini|opencode|openai_|anthropic_|tt_qa_)/iu.test(key)));
  const isolatedPath = [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';');
  Object.assign(filtered, {
    Path: isolatedPath,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_V3_DATA: data,
    THREADTERM_V3_USER_DATA: profile,
    THREADTERM_V3_PIPE: pipe,
    THREADTERM_V3_CONPTY: 'system',
    TT_QA_KIMI_LOG: logFile,
    TT_QA_KIMI_GATE: gateFile,
  });
  const pathKeys = Object.keys(filtered).filter(key => key.toLowerCase() === 'path');
  assert.deepEqual(pathKeys, ['Path'], 'child environment must have one isolated PATH spelling');
  assert.equal(filtered.Path, isolatedPath);
  return filtered;
}
async function closeOwnedRuntime() {
  let peer;
  try {
    peer = await connectPeer(`${pipe}-control`);
    const credential = (await readFile(join(data, 'runtime.credential'), 'utf8')).trim();
    assert.ok(credential, 'isolated runtime credential is empty');
    const challenge = JSON.parse(await peer.next());
    assert.equal(challenge.contract, PROTOCOL_CONTRACT, 'cleanup challenge contract must match');
    const clientId = randomUUID();
    peer.json({ kind: 'auth', clientId, protocol: 1, contract: PROTOCOL_CONTRACT, nonce: challenge.nonce,
      hmac: createHmac('sha256', credential).update(`1:${clientId}:${challenge.nonce}`).digest('hex') });
    const proof = JSON.parse(await peer.next());
    assert.equal(proof.kind, 'authenticated');
    assert.equal(proof.contract, PROTOCOL_CONTRACT);
    assert.equal(proof.hmac, createHmac('sha256', credential).update(`server:1:${clientId}:${challenge.nonce}`).digest('hex'));
    const snapshot = await peer.request('runtime.snapshot', {}, 10_000);
    assert.equal(snapshot.sessions.length, 0, 'only this empty isolated runtime may be stopped');
    await peer.request('runtime.shutdown', { operationId: randomUUID() }, 10_000);
    report.checks.push('authenticated peer shut down only the empty fixture-private runtime');
  } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error?.code)) throw error;
    report.checks.push('fixture-private runtime had already released its control pipe');
  } finally {
    peer?.close();
  }
}
async function verifyPrivatePipeClosed() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let peer;
    try {
      peer = await connectPeer(`${pipe}-control`);
      peer.close();
      await delay(100);
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error?.code)) throw error;
      report.checks.push('fixture-private runtime control pipe closed after authenticated shutdown');
      return;
    } finally {
      peer?.close();
    }
  }
  throw new Error('fixture-private runtime control pipe remained open after authenticated shutdown');
}

try {
  await mkdir(evidenceDir, { recursive: true });
  await Promise.all([bin, data, profile, home, appData, localAppData, temp].map(path => mkdir(path, { recursive: true })));
  await Promise.all([writeFile(logFile, ''), writeFile(gateFile, 'hold')]);
  await writeFile(join(bin, 'kimi.cmd'), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);

  app = await electron.launch({
    args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', root],
    cwd: bin,
    env: isolatedEnvironment(),
    timeout: 60_000,
  });
  page = await app.firstWindow({ timeout: 30_000 });
  page.on('pageerror', error => pageErrors.push(error instanceof Error ? error.stack ?? error.message : String(error)));
  page.setDefaultTimeout(10_000);
  await page.waitForFunction(() => Boolean(window.threadterm));

  const init = await until(async () => (await fixtureRows()).find(row => row.kind === 'initialize'), 'fake Kimi ACP initialize entered');
  report.kimiPid = init.pid;
  report.checks.push('real Desktop 1 app started its isolated runtime and reached the fake builtin-Kimi ACP initialize gate');

  await page.locator('.project-catalog').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 10_000 });
  assert.equal(await page.locator('.project-catalog').isVisible(), true,
    'project catalog must be visible after startup splash closes');
  const body = page.locator('body');
  assert.equal(await body.getByText(/Unable to connect to ThreadTerm runtime|Runtime unavailable/i).count(), 0,
    'pending provider discovery must not show a runtime failure');
  assert.equal(await body.getByRole('button', { name: /^Retry/i }).count(), 0,
    'pending provider discovery must not show a retry action');

  const repeatedSnapshots = [];
  for (let index = 0; index < 4; index++) {
    const started = Date.now();
    const snapshot = await Promise.race([
      page.evaluate(() => window.threadterm.request('runtime.snapshot', {})),
      delay(5_000).then(() => { throw new Error('runtime.snapshot exceeded 5s while fake Kimi initialize was held'); }),
    ]);
    const elapsed = Date.now() - started;
    repeatedSnapshots.push(elapsed);
    assert.equal(snapshot.providers.some(provider => provider.id === 'kimi'), false,
      'Kimi must remain pending until its held initialize response is released');
  }
  report.timingsMs.pendingSnapshots = repeatedSnapshots;
  const rowsWhileHeld = await fixtureRows();
  assert.equal(rowsWhileHeld.filter(row => row.kind === 'version').length, 1,
    'repeated snapshots must share one cold version probe');
  assert.equal(rowsWhileHeld.filter(row => row.kind === 'initialize').length, 1,
    'repeated snapshots must share one cold ACP initialize probe');
  report.checks.push('four production runtime.snapshot calls returned promptly while provider discovery remained pending, with one version and one ACP probe');

  await page.locator('button.nav-item.new').click();
  const creator = page.getByRole('dialog');
  await creator.waitFor({ state: 'visible' });
  await creator.getByText(/Detecting providers/i).waitFor({ state: 'visible' });
  const kimiChoice = creator.getByRole('button', { name: /Kimi/i });
  assert.equal(await kimiChoice.isDisabled(), true, 'unconfirmed Kimi must not be presented as installed');
  assert.equal(await creator.getByRole('button', { name: /^Retry/i }).count(), 0);
  await page.screenshot({ path: pendingScreenshotPath, fullPage: true });
  report.pendingScreenshot = pendingScreenshotPath;
  report.checks.push('renderer remained interactive and showed provider detection instead of Runtime unavailable or Retry');

  await page.evaluate(() => {
    window.__coldProviderEvents = [];
    window.__coldProviderUnsubscribe = window.threadterm.onEvent(event => window.__coldProviderEvents.push(event));
  });
  // The runtime's ACP request deadline is 30 seconds. Keep the child wedged
  // beyond that deadline to reproduce a Desktop request timeout if discovery
  // were still synchronous, while sampling the real renderer and RPC path.
  const beyondProviderDeadline = init.at + 31_000;
  let heldSnapshots = 0;
  while (Date.now() < beyondProviderDeadline) {
    const started = Date.now();
    const snapshot = await Promise.race([
      page.evaluate(() => window.threadterm.request('runtime.snapshot', {})),
      delay(5_000).then(() => { throw new Error('runtime.snapshot stalled during the 30s fake Kimi handshake'); }),
    ]);
    const elapsed = Date.now() - init.at;
    heldSnapshots++;
    const kimi = snapshot.providers.find(provider => provider.id === 'kimi');
    if (elapsed < 29_500) {
      assert.equal(kimi, undefined, 'Kimi remains pending before the provider handshake deadline settles');
    } else if (kimi) {
      assert.equal(kimi.installed, true, 'the successful isolated version probe must preserve installed status');
      assert.equal(kimi.chat, false, 'the fake handshake is still held, so Chat is not confirmed available');
    }
    assert.ok(Date.now() - started < 5_000);
    assert.equal(await body.getByText(/Unable to connect to ThreadTerm runtime|Runtime unavailable/i).count(), 0,
      'the app must stay connected for the full provider deadline');
    assert.equal(await body.getByRole('button', { name: /^Retry/i }).count(), 0,
      'the app must not expose Retry during provider discovery');
    await delay(Math.min(900, Math.max(0, beyondProviderDeadline - Date.now())));
  }
  report.timingsMs.fakeInitializeHeld = Date.now() - init.at;
  report.heldSnapshots = heldSnapshots;
  assert.ok(report.timingsMs.fakeInitializeHeld > 30_000, 'fake Kimi initialize must be held beyond 30 seconds');

  // The runtime's provider request times out at 30 seconds. Releasing the fake
  // gate also covers implementations that retain the child until cleanup.
  await writeFile(gateFile, 'release');
  await until(async () => {
    const events = await page.evaluate(() => window.__coldProviderEvents);
    return events.find(event => event.event === 'state.changed' && event.data?.kind === 'providers');
  }, 'provider completion state.changed event', 20_000);
  await until(async () => {
    const snapshot = await page.evaluate(() => window.threadterm.request('runtime.snapshot', {}));
    const kimi = snapshot.providers.find(provider => provider.id === 'kimi');
    return kimi?.installed;
  }, 'completed Kimi capability in runtime snapshot', 10_000);
  if (await page.getByRole('dialog').count() === 0) await page.locator('button.nav-item.new').click();
  const updatedCreator = page.getByRole('dialog');
  await updatedCreator.getByRole('button', { name: /Kimi/i }).waitFor({ state: 'visible' });
  assert.equal(await updatedCreator.getByRole('button', { name: /Kimi/i }).isDisabled(), false,
    'renderer must reflect the now-confirmed installed Kimi capability');
  assert.equal(await body.getByText(/Unable to connect to ThreadTerm runtime|Runtime unavailable/i).count(), 0);
  await page.screenshot({ path: confirmedScreenshotPath, fullPage: true });
  report.confirmedScreenshot = confirmedScreenshotPath;
  const finalRows = await fixtureRows();
  assert.equal(finalRows.filter(row => row.kind === 'version').length, 1);
  assert.equal(finalRows.filter(row => row.kind === 'initialize').length, 1);
  report.checks.push('completion emitted state.changed kind=providers and refreshed the live renderer capability to installed');
  report.checks.push('completion reused the single cold provider probe');
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  await page?.screenshot({ path: join(scratch, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  // Release the fake first so its probe exits and the runtime can be stopped
  // cleanly through the isolated authenticated desktop connection.
  await writeFile(gateFile, 'release').catch(() => {});
  if (page) {
    await page.evaluate(() => window.__coldProviderUnsubscribe?.()).catch(() => {});
  }
  if (app) {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
  }
  try { await closeOwnedRuntime(); } catch (error) { cleanupError = error; }
  try { await verifyPrivatePipeClosed(); } catch (error) { cleanupError ??= error; }
  if (app) {
    await app.close().catch(error => {
      cleanupError ??= error;
    });
  }
  const rows = await fixtureRows();
  if (rows.some(row => row.kind === 'acp-start')) {
    report.checks.push('the held fake ACP process was owned by the isolated runtime and no duplicate ACP probe started');
  }
  if (report.kimiPid) {
    try {
      const tasklist = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe'),
        ['/FI', `PID eq ${report.kimiPid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      assert.equal(tasklist.includes(`"${report.kimiPid}"`), false, 'runtime shutdown must leave no fake Kimi child process');
      report.checks.push('the recorded fake Kimi process exited after runtime cleanup');
    } catch (error) {
      cleanupError ??= error;
      report.errors.push(`fake Kimi process cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  report.fakeProcesses = rows.filter(row => row.kind === 'acp-start').length;
  report.fakeVersionProbes = rows.filter(row => row.kind === 'version').length;
  if (cleanupError) {
    report.passed = false;
    report.errors.push(`Electron cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
  }
  report.pageErrors = pageErrors;
  if (pageErrors.length) {
    report.passed = false;
    report.errors.push(`renderer emitted ${pageErrors.length} pageerror event(s)`);
  }
  report.completedAt = new Date().toISOString();
  report.reportPath = reportPath;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!keep && !cleanupError) await rm(scratch, { recursive: true, force: true });
  if (!report.passed) process.exitCode = 1;
}
