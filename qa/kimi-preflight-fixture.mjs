// kimi-20261111-1: credential-free Kimi terminal compatibility regression.
// Reuses the isolated runtime/real PTY + pipe-client harness from
// agent-terminal-resume.mjs and the fake-provider injection of session-release.mjs.
// Run after building the debug runtime: node qa/kimi-preflight-fixture.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectPeer } from './pipe-client.mjs';

assert.equal(process.platform, 'win32', 'Windows real-PTY regression');
const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp('D:/project/ThreadTerm/tt-qa-temp/i57/preflight-');
const bin = join(scratch, 'bin'), data = join(scratch, 'data'), store = join(scratch, 'native');
const home = join(scratch, 'home');
await Promise.all([bin, data, store, home].map(path => mkdir(path)));
await writeFile(join(store, 'events.jsonl'), '');
await copyFile(join(root, 'runtime/tests/fixtures/kimi-20261111-1.mjs'), join(bin, 'kimi-20261111-1.mjs'));
await writeFile(join(bin, 'kimi.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0kimi-20261111-1.mjs" %*\r\n`);
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const pipe = `\\\\.\\pipe\\tt-kimi-preflight-${randomUUID()}`;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(SystemRoot|WINDIR|COMSPEC|PATHEXT|ProgramData)$/i.test(key))),
  Path: [bin, dirname(process.execPath), join(process.env.SystemRoot, 'System32')].join(';'),
  HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'local'),
  TEMP: scratch, TMP: scratch, KIMI_CODE_HOME: join(home, '.kimi'),
  THREADTERM_QA_PROVIDER_BIN: bin, TT_QA_KIMI_STORE: store,
  THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(scratch, 'user-data'), THREADTERM_V3_PIPE: pipe,
};
const report = { compat: 'kimi-20261111-1', scratch, runtime, passed: false, checks: [],
  notVerified: ['Live Kimi 2.6.0 and 2.0.2, vendor policy/network, install/retry, full TUI rendering; replay only'] };
let peer, daemon, diagnostic = '';
const active = new Set();
async function until(read, accept, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}; runtime stderr: ${diagnostic}`);
}
const journal = async () => (await readFile(join(store, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const state = async id => (await peer.request('runtime.snapshot')).sessions.find(session => session.id === id);
const output = async id => Buffer.from((await peer.request('terminal.read', { sessionId: id, cursor: 0, limit: 1048576 })).data, 'base64').toString();
const plain = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
async function checkState(created, status, code) {
  const current = await state(created.id);
  assert.equal(current.nativeId, created.nativeId, 'native ID stays preassigned');
  assert.equal(current.status, status);
  assert.equal(current.exitCode, code);
  assert.equal(current.provider, 'kimi');
  assert.equal(current.mode, 'terminal');
}
async function send(created, text) {
  const { leaseEpoch } = await peer.request('session.claim', { sessionId: created.id, clientId: 'kimi-preflight-qa' });
  try { await peer.request('terminal.input', { sessionId: created.id, data: text, leaseEpoch }); }
  finally { await peer.request('session.release', { sessionId: created.id, leaseEpoch }); }
}
try {
  daemon = spawn(runtime, [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  daemon.stderr.on('data', bytes => { diagnostic += bytes; });
  await until(async () => {
    try {
      peer = await connectPeer(`${pipe}-control`);
      await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      return true;
    } catch (error) {
      peer?.close(); peer = undefined;
      if (daemon.exitCode !== null) throw error;
      return false;
    }
  }, Boolean, 'isolated runtime startup');
  await until(() => peer.request('provider.list'), providers => providers.some(provider =>
    provider.id === 'kimi' && provider.terminal && provider.terminalResumeCapture === 'preassigned'), 'fake Kimi discovery');
  for (const scenario of ['skip', 'interrupt', 'floor']) {
    const cwd = join(scratch, scenario);
    await mkdir(cwd);
    // Must return while the prompt is awaiting input; no input is sent until after this RPC.
    const created = await peer.request('session.create', { cwd, provider: 'kimi', mode: 'terminal',
      title: `Kimi preflight ${scenario}`, operationId: randomUUID() }, 20_000);
    active.add(created.id);
    assert.ok(created.nativeId);
    await until(journal, rows => rows.some(row => row.kind === 'terminal' && row.sessionId === created.nativeId), 'requested --session ID');
    const rows = await journal();
    const launch = rows.find(row => row.kind === 'terminal' && row.sessionId === created.nativeId);
    assert.deepEqual(launch.args, ['--session', created.nativeId]);
    assert.ok(rows.some(row => row.kind === 'loaded' && row.sessionId === created.nativeId), 'ACP verified the same ID');
    await checkState(created, 'running', undefined);
    if (scenario !== 'floor') {
      await until(() => output(created.id), text => plain(text).includes('Skip for this run (10s)'), 'active minimum-version prompt');
      const text = plain(await output(created.id));
      for (const expected of ['Kimi Code Upgrade Required', 'This version must be upgraded before continuing.',
        'Current  2.6.0', 'Minimum  2.6.1', 'Target   2.6.1', '↑↓ choose · Enter confirm', 'Install update now (2.6.1)']) {
        assert.ok(text.includes(expected), `missing prompt text: ${expected}`);
      }
      assert.ok(!text.includes('FIXTURE_ATTACHED:'), 'no attachment before input');
      assert.ok(!(await journal()).some(row => row.kind === 'attached' && row.sessionId === created.nativeId));
      await delay(300); // give projection/waiter a chance to misclassify the displayed prompt
      await checkState(created, 'running', undefined);
      if (scenario === 'interrupt') {
        await send(created, '\x03');
        await until(() => state(created.id), current => current.status === 'exited', 'Ctrl+C process exit');
        await checkState(created, 'exited', 130);
        const interrupted = (await journal()).filter(row => row.sessionId === created.nativeId);
        assert.ok(interrupted.some(row => row.kind === 'interrupted' && row.code === 130));
        assert.ok(!interrupted.some(row => row.kind === 'attached'));
        assert.ok(!(await output(created.id)).includes('FIXTURE_ATTACHED:'));
      } else {
        await send(created, '\x1b[B'); // choose Skip; Enter is ignored during the upstream ten-second gate
        await send(created, '\r');
        await until(journal, entries => entries.some(row => row.kind === 'skip-disabled' && row.sessionId === created.nativeId), 'disabled Skip');
        await checkState(created, 'running', undefined);
        const prompt = (await journal()).find(row => row.kind === 'prompt' && row.sessionId === created.nativeId);
        await delay(Math.max(0, prompt.skipAvailableAt - Date.now()) + 300);
        await send(created, '\r');
      }
    }
    if (scenario !== 'interrupt') {
      await until(() => output(created.id), text => text.includes(`FIXTURE_ATTACHED:${created.nativeId}:${scenario === 'floor' ? '2.0.2' : '2.6.0'}`), 'attachment of the requested ID');
      assert.ok(plain(await output(created.id)).includes(`Session:   ${created.nativeId}`));
      const attached = (await journal()).filter(row => row.sessionId === created.nativeId);
      assert.equal(attached.filter(row => row.kind === 'attached').length, 1);
      assert.equal(attached.some(row => row.kind === 'skip'), scenario === 'skip');
      if (scenario === 'floor') assert.ok(!(await output(created.id)).includes('Upgrade Required'));
      await delay(300);
      await checkState(created, 'running', undefined);
      await send(created, 'q');
      await until(() => state(created.id), current => current.status === 'exited', 'ordinary process exit');
      await checkState(created, 'exited', 0);
    }
    await writeFile(join(scratch, `${scenario}-pty.txt`), await output(created.id));
    report.checks.push({ scenario, nativeId: created.nativeId, final: await state(created.id) });
    active.delete(created.id);
    console.log(`PASS ${scenario}: requested native ID preserved; ${scenario === 'interrupt' ? 'exited 130 before attachment' : 'attached, stayed running, exited 0'}`);
  }
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  for (const sessionId of active) await peer?.request('session.stop', { sessionId, force: true, operationId: randomUUID() }).catch(() => {});
  await peer?.request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  peer?.close();
  if (daemon) {
    for (let i = 0; i < 100 && daemon.exitCode === null; i++) await delay(50);
    if (daemon.exitCode === null) daemon.kill(); // only the isolated runtime we started
  }
  await writeFile(join(scratch, 'report.json'), JSON.stringify({ ...report, diagnostic }, null, 2));
  console.log(`Kimi preflight artifacts: ${scratch}`);
}
