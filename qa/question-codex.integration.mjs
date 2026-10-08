// Native-pipe integration for Codex question and elicitation responses. The
// fixture is the only executable on PATH, so this cannot start a real agent.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectSubagentPeer } from './lib/subagent-peer.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-question-codex-'));
const bin = join(scratch, 'bin'), cwd = join(scratch, 'workspace'), data = join(scratch, 'data');
const log = join(scratch, 'fake.jsonl'), out = resolve('qa/results/question-codex');
await Promise.all([bin, cwd, out].map(path => mkdir(path, { recursive: true }))); await writeFile(log, '');
const pipe = String.raw`\\.\pipe\threadterm-question-codex-${randomUUID()}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'codex_home', 'openai_api_key', 'threadterm_v3_data', 'threadterm_v3_pipe'].includes(key.toLowerCase())));
Object.assign(env, {
  Path: [bin, join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
  THREADTERM_V3_DATA: data, THREADTERM_V3_PIPE: pipe, CODEX_HOME: join(scratch, 'provider-home'),
  TT_QA_NODE: process.execPath, TT_QA_SCRIPT: resolve('qa/fixtures/fake-codex-questions.cjs'),
  THREADTERM_QA_CODEX_QUESTIONS_LOG: log, THREADTERM_QA_CODEX_QUESTIONS_CWD: cwd,
});
assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path']);
await writeFile(join(bin, 'shim.rs'), 'fn main(){let status=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}');
const compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'codex.exe')], { encoding: 'utf8', windowsHide: true });
assert.equal(compiled.status, 0, compiled.stderr);
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE ?? 'runtime/target/debug/threadterm-v3-runtime.exe');
const daemon = spawn(runtime, [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let diagnostic = '', peer; daemon.stderr.on('data', bytes => { diagnostic += bytes.toString(); });
const report = { passed: false, scratch, runtime, checks: [] };
const pause = ms => new Promise(done => setTimeout(done, ms));
async function until(read, accepts, label) { for (let i = 0; i < 200; i++) { const value = await read(); if (accepts(value)) return value; await pause(50); } throw new Error(`Timed out: ${label}`); }
async function connect() { const next = await connectSubagentPeer(`${pipe}-control`); await next.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim()); return next; }
async function pending(sessionId) { const snapshot = await until(() => peer.request('chat.snapshot', { sessionId }), snapshot => snapshot.items.flatMap(item => item.parts).some(part => part.type === 'approval' && part.status === 'pending'), 'pending question'); return snapshot.items.flatMap(item => item.parts).find(part => part.type === 'approval' && part.status === 'pending'); }
try {
  await until(async () => { try { peer = await connect(); return true; } catch { if (daemon.exitCode !== null) throw new Error(diagnostic); return false; } }, Boolean, 'runtime authentication');
  const session = await peer.request('session.create', { cwd, provider: 'codex', mode: 'chat', title: 'Codex question QA', operationId: randomUUID() });
  let { leaseEpoch } = await peer.request('session.claim', { sessionId: session.id });
  await peer.request('chat.connect', { sessionId: session.id, leaseEpoch, operationId: randomUUID() });
  async function run(prompt, response) {
    await peer.request('chat.send', { sessionId: session.id, text: prompt, leaseEpoch, operationId: randomUUID() });
    const card = await pending(session.id); const turnId = card.data?.turnId ?? card.turnId; if (!turnId) throw new Error(`pending card lacks turnId: ${JSON.stringify(card)}`); await peer.request('chat.answer', { sessionId: session.id, turnId, approvalId: card.approvalId, response, leaseEpoch, operationId: randomUUID() });
    const resolvedSnapshot = await until(() => peer.request('chat.snapshot', { sessionId: session.id }), snapshot => snapshot.items.flatMap(item => item.parts).some(part => part.type === 'approval' && part.approvalId === card.approvalId && part.status !== 'pending'), 'resolved question'); const resolved = resolvedSnapshot.items.flatMap(item => item.parts).find(part => part.type === 'approval' && part.approvalId === card.approvalId && part.status !== 'pending');
    return { card, resolved };
  }
  const input = await run('input', { action: 'submit', values: { colour: ['Mauve'], token: ['secret-token'] } });
  assert.equal(input.card.data.interaction, 'question'); assert.equal(input.card.data.form.kind, 'questions');
  assert.equal(input.card.data.form.questions[0].allowOther, true); assert.equal(input.card.data.form.questions[1].secret, true);
  assert.equal(input.card.data.isBlocking, false); assert.equal(input.card.data.autoResolutionMs, 15000); assert.equal(input.resolved.status, 'answered'); assert.equal(input.resolved.data.answerSummary.token, '••••');
  const inputDismissed = await run('input', { action: 'dismiss' }); assert.equal(inputDismissed.resolved.status, 'dismissed');
  const form = await run('form', { action: 'submit', values: { name: 'a@b.co', count: 2, enabled: false, colour: 'red', tags: ['one', 'two'] } });
  assert.equal(form.card.data.form.kind, 'form'); assert.equal(form.card.data.form.fields.length, 5);
  const formDismissed = await run('form', { action: 'dismiss' }); assert.equal(formDismissed.resolved.status, 'dismissed');
  const unsupported = await run('unsupported', { action: 'dismiss' }); assert.equal(unsupported.card.data.answerable, false); assert.equal(unsupported.resolved.status, 'dismissed');
  const url = await run('url', { action: 'submit', values: {} }); assert.equal(url.card.data.form.kind, 'url');
  const urlDismissed = await run('url', { action: 'dismiss' }); assert.equal(urlDismissed.resolved.status, 'dismissed');
  const responses = (await readFile(log, 'utf8')).trim().split(/\r?\n/).map(JSON.parse).filter(entry => entry.direction === 'in' && String(entry.method).startsWith('qa-'));
  assert.deepEqual(responses.map(entry => [String(entry.method).replace(/-\d+$/, ''), entry.params]), [
    ['qa-input', { answers: { colour: { answers: ['Mauve'] }, token: { answers: ['secret-token'] } } }],
    ['qa-input', { answers: {} }],
    ['qa-form', { action: 'accept', content: { name: 'a@b.co', count: 2, enabled: false, colour: 'red', tags: ['one', 'two'] } }],
    ['qa-form', { action: 'decline' }], ['qa-unsupported', { action: 'decline' }], ['qa-url', { action: 'accept' }], ['qa-url', { action: 'decline' }],
  ]);
  report.checks = ['sanitized case-insensitive PATH and fake Codex fixture only', 'requestUserInput exact submit JSON including other/secret/options:null metadata', 'form exact accept content JSON', 'unsupported form exact decline JSON', 'url exact accept JSON']; report.passed = true;
} catch (error) { report.error = error.stack ?? String(error); report.diagnostic = diagnostic; process.exitCode = 1; }
finally { if (peer) { await peer.request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {}); peer.close(); } if (daemon.exitCode === null) await Promise.race([new Promise(done => daemon.once('exit', done)), pause(3000)]); if (daemon.exitCode === null) daemon.kill(); await writeFile(join(out, 'runtime-report.json'), `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2)); }
