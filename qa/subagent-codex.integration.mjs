// Isolated runtime + rustc fake-provider shim. Never launches a real agent CLI.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { connectSubagentPeer as connectPeer } from './lib/subagent-peer.mjs';

const pause = ms => new Promise(done => setTimeout(done, ms));
const root = await mkdtemp(join(tmpdir(), 'threadterm-subagent-codex-'));
const bin = join(root, 'bin');
const cwd = join(root, 'workspace');
const data = join(root, 'data');
const log = join(root, 'codex-requests.jsonl');
const release = join(root, 'release-parent.txt');
const pipe = `\\\\.\\pipe\\threadterm-subagent-codex-${randomUUID()}`;
await Promise.all([mkdir(bin), mkdir(cwd), writeFile(log, ''), writeFile(release, '')]);
const shim = 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}';
await writeFile(join(bin, 'shim.rs'), shim);
const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'codex.exe')], { encoding: 'utf8', windowsHide: true });
assert.equal(compiled.status, 0, compiled.stderr);
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE || 'runtime/target/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtime), `Missing built runtime: ${runtime}`);
const runtimeCopy = join(root, 'runtime.exe');
await copyFile(runtime, runtimeCopy);
const environment = {
  // Strip EVERY case variant first. Multiple Windows PATH keys can expose real CLIs.
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'codex_home', 'threadterm_v3_data', 'threadterm_v3_pipe'].includes(key.toLowerCase()))),
  Path: [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_DATA: data, THREADTERM_V3_PIPE: pipe, CODEX_HOME: join(root, 'provider-home'),
  TT_QA_NODE: process.execPath, TT_QA_SCRIPT: resolve('qa/fixtures/fake-codex-subagent.cjs'),
  THREADTERM_QA_CODEX_SUBAGENT_LOG: log, THREADTERM_QA_CODEX_SUBAGENT_CWD: cwd,
  THREADTERM_QA_CODEX_SUBAGENT_RELEASE: release,
};
assert.deepEqual(Object.keys(environment).filter(key => key.toLowerCase() === 'path'), ['Path']);
assert.equal(environment.TT_QA_SCRIPT, resolve('qa/fixtures/fake-codex-subagent.cjs'));
assert.ok(existsSync(join(bin, 'codex.exe')));
console.log('Isolation verified: one sanitized Path, compiled codex.exe shim, fake-codex-subagent.cjs.');
const daemon = spawn(runtimeCopy, [], { env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let diagnostic = '';
daemon.stderr.on('data', bytes => { diagnostic += bytes.toString(); });
let peer;
let lastConnectError;
let report = { passed: false, root, checks: [], scenarios: 3 };
const waitFor = async (read, accept, label) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (accept(value)) return value;
    await pause(50);
  }
  throw Error(`Timed out: ${label}; ${lastConnectError?.stack ?? ''}`);
};
try {
  let clientId;
  await waitFor(async () => {
    try {
      peer = await connectPeer(`${pipe}-control`);
      clientId = await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      return true;
    } catch (error) { lastConnectError = error; peer?.close(); peer = undefined; if (daemon.exitCode !== null) throw Error(diagnostic); return false; }
  }, Boolean, 'authenticated runtime');
  for (const mode of ['normal', 'slow', 'approval']) {
    const scenarioCwd = join(cwd, `scenario-${mode}`);
    await mkdir(scenarioCwd);
    const parentId = `qa-subagent-parent-${mode}`;
    const created = await peer.request('session.create', { cwd: scenarioCwd, title: `Codex subagent ${mode}`, provider: 'codex', mode: 'chat', operationId: randomUUID() });
    const sessionId = created.id;
    const { leaseEpoch } = await peer.request('session.claim', { sessionId, clientId });
    assert.equal((await peer.request('chat.connect', { sessionId, leaseEpoch, operationId: randomUUID() })).phase, 'ready');
    const rows = () => peer.request('chat.read', { sessionId });
    const parts = async () => (await rows()).flatMap(item => item.parts);
    const state = async () => (await peer.request('runtime.snapshot')).sessions.find(row => row.id === sessionId);
    const requests = async () => (await readFile(log, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
    const before = (await requests()).length;
    await writeFile(release, '');
    const sent = await peer.request('chat.send', { sessionId, text: mode, leaseEpoch, operationId: randomUUID() });
    await waitFor(parts, values => values.some(part => part.type === 'subagent'), `${mode} card`);
    if (mode === 'slow') {
      const transcript = await waitFor(() => peer.request('chat.subagent.read', { sessionId, key: 'qa-subagent-child' }), value => value.items.some(item => item.parts.some(part => part.type === 'tool')), 'open child command');
      assert.equal(transcript.items.filter(item => item.parts.some(part => part.type === 'tool')).length, 1);
      assert.equal((await state()).status, 'running');
      await peer.request('chat.cancel', { sessionId, turnId: sent.turnId, leaseEpoch, operationId: randomUUID() });
      const records = await waitFor(requests, values => values.slice(before).some(row => row.method === 'interrupt.recorded'), 'recorded interrupt');
      assert.deepEqual(records.slice(before).find(row => row.method === 'interrupt.recorded').params, { threadId: parentId, turnId: 'qa-parent-turn-1' });
      await waitFor(state, value => value.status === 'idle', 'cancel parent ended');
      report.checks.push('slow: Stop interrupts the parent thread and parent native turn');
    } else {
      if (mode === 'approval') {
        const pending = (await waitFor(parts, values => values.some(part => part.type === 'approval' && part.status === 'pending'), 'child approval')).find(part => part.type === 'approval' && part.status === 'pending');
        assert.equal(pending.data.subagent.key, 'qa-subagent-child');
        assert.ok(pending.data.subagent.label);
        await peer.request('chat.approve', { sessionId, turnId: sent.turnId, approvalId: pending.approvalId, choiceId: 'accept', leaseEpoch, operationId: randomUUID() });
        const records = await waitFor(requests, values => values.slice(before).some(row => row.method === 'approval.response'), 'fake received approval');
        assert.equal(records.slice(before).find(row => row.method === 'approval.response').params.decision, 'accept');
        report.checks.push('approval: labeled child request reaches fake and unblocks child');
      }
      await waitFor(parts, values => values.some(part => part.type === 'subagent' && part.data.status === 'completed'), 'child completed before parent');
      assert.equal((await state()).status, 'running', 'child completion must leave parent running');
      assert.equal((await requests()).slice(before).some(row => row.method === 'event.turn/completed' && row.params.threadId === parentId), false);
      await writeFile(release, 'qa-parent-turn-1');
      await waitFor(state, value => value.status === 'idle', 'parent completed');
      const parentParts = await parts();
      assert.equal(parentParts.some(part => part.type === 'tool' && JSON.stringify(part).includes('CHILD-COMMAND')), false);
      assert.equal(parentParts.some(part => part.type === 'text' && part.text?.includes('CHILD-ANSWER')), false);
      const cards = parentParts.filter(part => part.type === 'subagent');
      assert.equal(cards.length, 1);
      assert.equal(cards[0].data.status, 'completed');
      assert.equal(cards[0].data.toolCount, 1);
      const transcript = await peer.request('chat.subagent.read', { sessionId, key: cards[0].data.key });
      assert.equal(transcript.source, 'live');
      assert.equal(transcript.items.filter(item => item.parts.some(part => part.type === 'tool')).length, 1);
      assert.ok(transcript.items.some(item => item.parts.some(part => part.text === 'CHILD-ANSWER: three files')));
      assert.ok(parentParts.some(part => part.text === 'PARENT-FINAL: verified file count'));
      const records = (await requests()).slice(before);
      const childEnd = records.findIndex(row => row.method === 'event.turn/completed' && row.params.threadId === 'qa-subagent-child');
      const parentEnd = records.findIndex(row => row.method === 'event.turn/completed' && row.params.threadId === parentId);
      assert.ok(parentEnd > childEnd && childEnd >= 0);
      report.checks.push(`${mode}: isolated child transcript, one completed card/tool, parent remains running until parent completion`);
    }
    await peer.request('session.stop', { sessionId, operationId: randomUUID() });
  }
  report.passed = true;
  report.checkCount = report.checks.length;
} catch (error) {
  report.error = error.stack ?? String(error);
  report.diagnostic = diagnostic;
  process.exitCode = 1;
} finally {
  if (peer) { await peer.request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {}); peer.close(); }
  if (daemon.exitCode === null) await Promise.race([new Promise(done => daemon.once('exit', done)), pause(3000)]);
  if (daemon.exitCode === null) daemon.kill();
  await writeFile(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
