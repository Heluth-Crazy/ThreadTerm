// Isolated runtime + rustc fake-provider shim for Chat Code Review (Standard).
// Never launches a real agent CLI.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { connectSubagentPeer as connectPeer } from './lib/subagent-peer.mjs';

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const root = await mkdtemp(join(tmpdir(), 'threadterm-code-review-'));
const bin = join(root, 'bin');
const cwd = join(root, 'workspace');
const data = join(root, 'data');
const log = join(root, 'codex-requests.jsonl');
const hold = join(root, 'hold.txt');
const pipe = `\\\\.\\pipe\\threadterm-code-review-${randomUUID()}`;
await Promise.all([mkdir(bin), mkdir(cwd), writeFile(log, ''), writeFile(hold, '0')]);

const shim = 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}';
await writeFile(join(bin, 'shim.rs'), shim);
const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'codex.exe')], { encoding: 'utf8', windowsHide: true });
assert.equal(compiled.status, 0, compiled.stderr);

const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE || process.env.THREADTERM_V3_RUNTIME_BIN || 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtime), `Missing built runtime: ${runtime}`);
const runtimeCopy = join(root, 'runtime.exe');
await copyFile(runtime, runtimeCopy);

function git(...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
git('init', '-q');
git('config', 'user.email', 'qa@example.invalid');
git('config', 'user.name', 'ThreadTerm QA');
await mkdir(join(cwd, 'src'), { recursive: true });
await writeFile(join(cwd, 'src/bug.ts'), 'export const value = null;\nexport const boom = () => value.x;\n');
git('add', '.');
git('commit', '-qm', 'initial');
await writeFile(join(cwd, 'src/bug.ts'), 'export const value = null;\nexport const boom = () => value.x;\nexport const extra = 1;\n');

const gitExe = (spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout || '')
  .split(/\r?\n/).filter(Boolean).find((path) => /\\cmd\\git\.exe$/i.test(path))
  ?? (spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout || '').split(/\r?\n/).filter(Boolean)[0];
assert.ok(gitExe, 'git was not found');
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'codex_home', 'threadterm_v3_data', 'threadterm_v3_pipe'].includes(key.toLowerCase()))),
  Path: [bin, dirname(process.execPath), dirname(gitExe), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_DATA: data,
  THREADTERM_V3_PIPE: pipe,
  CODEX_HOME: join(root, 'provider-home'),
  TT_QA_NODE: process.execPath,
  TT_QA_SCRIPT: resolve('qa/fixtures/fake-codex-code-review.cjs'),
  THREADTERM_QA_CODE_REVIEW_LOG: log,
  THREADTERM_QA_CODE_REVIEW_HOLD: hold,
};
assert.deepEqual(Object.keys(environment).filter((key) => key.toLowerCase() === 'path'), ['Path']);
assert.ok(existsSync(join(bin, 'codex.exe')));
console.log('Isolation verified: sanitized Path, compiled codex.exe shim, fake-codex-code-review.cjs.');

const daemon = spawn(runtimeCopy, [], { env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let diagnostic = '';
daemon.stderr.on('data', (bytes) => { diagnostic += bytes.toString(); });
let peer;
let lastConnectError;
const report = { passed: false, root, checks: [] };

const waitFor = async (read, accept, label, attempts = 400) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
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
    } catch (error) {
      lastConnectError = error;
      peer?.close();
      peer = undefined;
      if (daemon.exitCode !== null) throw Error(diagnostic || String(error));
      return false;
    }
  }, Boolean, 'authenticated runtime');

  const created = await peer.request('session.create', {
    cwd, title: 'Code review parent', provider: 'codex', mode: 'chat', operationId: randomUUID(),
  });
  const sessionId = created.id;
  const { leaseEpoch } = await peer.request('session.claim', { sessionId, clientId });
  assert.equal((await peer.request('chat.connect', { sessionId, leaseEpoch, operationId: randomUUID() })).phase, 'ready');

  const snapshot = () => peer.request('runtime.snapshot');
  const parentState = async () => (await snapshot()).sessions.find((row) => row.id === sessionId);
  const parentBefore = await parentState();
  assert.equal(parentBefore.status, 'idle');
  const parentActivity = parentBefore.activity;

  const started = await peer.request('codeReview.start', {
    sessionId,
    provider: 'codex',
    depth: 'standard',
    scope: { kind: 'uncommitted' },
    operationId: randomUUID(),
    leaseEpoch,
  });
  assert.ok(started.reviewId);
  assert.ok(started.itemId);

  const completedCard = await waitFor(async () => {
    const items = await peer.request('chat.read', { sessionId });
    const part = items.flatMap((item) => item.parts).find((entry) => entry.type === 'subagent' && entry.data?.review?.reviewId === started.reviewId);
    return part?.data;
  }, (info) => info?.status === 'completed', 'review completed');

  assert.equal(completedCard.transcript, 'session');
  assert.equal(completedCard.review.depth, 'standard');
  assert.equal(completedCard.review.findings?.length, 1);
  assert.equal(completedCard.review.findings[0].verdict, 'confirmed');
  assert.equal(completedCard.review.findings[0].title, 'Null dereference');
  report.checks.push('Standard review completes with one confirmed finding');

  const transcript = await peer.request('chat.subagent.read', { sessionId, key: `review:${started.reviewId}`, afterRev: 0 });
  assert.equal(transcript.source, 'session');
  const stageLabels = transcript.items.filter((item) => item.role === 'system').map((item) => item.parts.map((part) => part.text).join(''));
  assert.ok(stageLabels.some((text) => /finder|Finding|review/i.test(text)), 'transcript includes finder stage');
  assert.ok(stageLabels.some((text) => /verif/i.test(text)), 'transcript includes verifier stage');
  assert.ok(transcript.items.length >= 2, 'transcript returns both stages');
  report.checks.push('chat.subagent.read returns both stages as session source');

  const after = await snapshot();
  const reviewers = after.sessions.filter((session) => session.codeReview?.reviewId === started.reviewId);
  assert.ok(reviewers.length >= 2, 'finder and verifier sessions are marked');
  assert.ok(reviewers.every((session) => session.codeReview?.parentSessionId === sessionId));
  const parentAfter = after.sessions.find((session) => session.id === sessionId);
  assert.equal(parentAfter.status, parentBefore.status);
  assert.deepEqual(parentAfter.activity, parentActivity);
  report.checks.push('reviewer sessions carry codeReview; parent status/activity unchanged');

  await writeFile(hold, '1');
  const hanging = await peer.request('codeReview.start', {
    sessionId,
    provider: 'codex',
    depth: 'standard',
    scope: { kind: 'uncommitted' },
    focus: 'QA_HOLD_REVIEW',
    operationId: randomUUID(),
    leaseEpoch,
  });
  await waitFor(async () => {
    const items = await peer.request('chat.read', { sessionId });
    return items.flatMap((item) => item.parts).find((entry) => entry.type === 'subagent' && entry.data?.review?.reviewId === hanging.reviewId);
  }, (part) => part?.data?.status === 'running', 'second review running');

  let activeError;
  try {
    await peer.request('codeReview.start', {
      sessionId,
      provider: 'codex',
      depth: 'quick',
      scope: { kind: 'uncommitted' },
      operationId: randomUUID(),
      leaseEpoch,
    });
  } catch (error) {
    activeError = error;
  }
  assert.equal(activeError?.code || activeError?.message, 'review_active');
  report.checks.push('second start while running returns review_active');

  await peer.request('codeReview.cancel', {
    sessionId,
    reviewId: hanging.reviewId,
    operationId: randomUUID(),
    leaseEpoch,
  });
  await waitFor(async () => {
    const items = await peer.request('chat.read', { sessionId });
    return items.flatMap((item) => item.parts).find((entry) => entry.type === 'subagent' && entry.data?.review?.reviewId === hanging.reviewId)?.data;
  }, (info) => info?.status === 'cancelled', 'review cancelled');
  report.checks.push('cancel ends the review in cancelled');

  report.passed = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  report.diagnostic = diagnostic;
  process.exitCode = 1;
} finally {
  if (peer) {
    await peer.request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
    peer.close();
  }
  if (daemon.exitCode === null) await Promise.race([new Promise((done) => daemon.once('exit', done)), pause(3000)]);
  if (daemon.exitCode === null) daemon.kill();
  console.log(JSON.stringify(report, null, 2));
  // The runtime copy, data dir and workspace are scratch; the report is printed above.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
