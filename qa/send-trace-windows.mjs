// Desktop-1 real-runtime QA for the opt-in send trace. The Codex process is a
// local JSONL fixture; this test never reaches a provider or account.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { electron } from './lib/desktop1.mjs';

assert.equal(process.platform, 'win32');
const option = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const enabled = process.argv.includes('--enabled');
assert.notEqual(enabled, process.argv.includes('--disabled'), 'pass exactly one of --enabled or --disabled');
const runtime = option('--runtime');
assert.ok(runtime && existsSync(runtime), 'pass --runtime <threadterm-v3-runtime.exe>');
const keep = process.argv.includes('--keep');
process.env.TT_QA_DESKTOP = '1';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), `tt-send-trace-${enabled ? 'on' : 'off'}-`));
const bin = join(scratch, 'bin');
const plain = join(scratch, 'plain');
const data = join(scratch, 'data');
const profile = join(scratch, 'profile');
const home = join(scratch, 'home');
const providerHome = join(scratch, 'provider-home');
const appData = join(scratch, 'appdata');
const localAppData = join(scratch, 'localappdata');
const runtimeLog = join(data, 'runtime.log');
const fakeLog = join(scratch, 'fake.jsonl');
const gitLog = join(scratch, 'git.jsonl');
const gate = join(scratch, 'git.gate');
const release = join(scratch, 'fake.release');
const fixture = join(root, 'qa', 'fixtures', 'fake-codex-latency.cjs');
const results = join(root, 'qa', 'results', 'send-trace-followup');
const reportPath = join(results, enabled ? 'enabled.json' : 'disabled.json');
const report = { passed: false, enabled, checks: [], scenarios: {} };
let app;
let page;

const where = executable => execFileSync('where', [executable], { encoding: 'utf8', windowsHide: true })
  .split(/\r?\n/u).find(Boolean);
const realGit = where('git');
const python = where('python');
assert.ok(realGit && python);
const delay = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
async function until(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function traceRows() {
  const lines = (await readFile(runtimeLog, 'utf8').catch(() => '')).split(/\r?\n/u);
  const rows = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row?.kind === 'threadterm.sendTrace') rows.push(row);
    } catch {}
  }
  return rows;
}
async function text(path) { return readFile(path, 'utf8').catch(() => ''); }
function ordered(rows, stages, source) {
  const selected = rows.filter(row => row.source === source).sort((a, b) => a.monotonicUs - b.monotonicUs);
  let cursor = -1;
  for (const stage of stages) {
    cursor = selected.findIndex((row, index) => index > cursor && row.stage === stage);
    assert.notEqual(cursor, -1, `${source} stage missing or out of order: ${stage}`);
  }
}
function sanitizedEnvironment() {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(path|home|userprofile|appdata|localappdata|threadterm_|codex|codex_home|claude|grok|gemini|opencode|openai_|anthropic_|tt_qa_)/iu.test(key)));
  const isolatedPath = [bin, dirname(realGit), dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';');
  Object.assign(clean, {
    Path: isolatedPath,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: providerHome,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    THREADTERM_V3_RUNTIME: resolve(runtime),
    THREADTERM_V3_DATA: data,
    THREADTERM_V3_USER_DATA: profile,
    THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-send-trace-${randomUUID()}`,
    TT_QA_REAL_GIT: realGit,
    TT_QA_GIT_GATE: gate,
    TT_QA_GIT_LOG: gitLog,
    TT_QA_FAKE_CODEX_LOG: fakeLog,
    TT_QA_FAKE_CODEX_CWD: plain,
    TT_QA_FAKE_RELEASE_FILE: release,
    TT_QA_PYTHON: python,
    TT_QA_RUNTIME_DB: join(data, 'threadterm-v3.sqlite3'),
    TT_QA_PROMPT: 'send trace prompt',
  });
  if (enabled) clean.THREADTERM_V3_SEND_TRACE = '1';
  assert.equal(Object.keys(clean).filter(key => key.toLowerCase() === 'path').length, 1);
  assert.equal(clean.Path, isolatedPath);
  return clean;
}
async function createChat(rpc, cwd, name) {
  const project = await rpc('project.add', { path: cwd, name, operationId: randomUUID() });
  const session = await rpc('session.create', {
    projectId: project.id, cwd, title: name, provider: 'codex', mode: 'chat', operationId: randomUUID(),
  });
  const lease = await rpc('session.claim', { sessionId: session.id, clientId: 'send-trace-qa' });
  await rpc('chat.connect', { sessionId: session.id, leaseEpoch: lease.leaseEpoch, operationId: randomUUID() });
  await until(async () => (await rpc('chat.connection', { sessionId: session.id })).phase === 'ready', `${name} ready`);
  return { session, leaseEpoch: lease.leaseEpoch };
}

try {
  await Promise.all([bin, plain, data, profile, home, providerHome, appData, localAppData, results]
    .map(path => mkdir(path, { recursive: true })));
  const hostGit = args => execFileSync(realGit, args, { cwd: plain, stdio: 'pipe', windowsHide: true });
  await writeFile(join(scratch, 'git.rs'), String.raw`use std::{env,fs,io::Write,process::{Command,Stdio},thread,time::Duration,os::windows::process::CommandExt};const H:u32=0x08000000;fn main(){let a:Vec<_>=env::args_os().skip(1).collect();let t=a.iter().map(|x|x.to_string_lossy()).collect::<Vec<_>>().join(" ");let g=env::var("TT_QA_GIT_GATE").unwrap();if fs::read_to_string(&g).unwrap_or_default().trim()=="checkpoint"&&t.contains("--is-inside-work-tree"){let mut f=fs::OpenOptions::new().create(true).append(true).open(env::var("TT_QA_GIT_LOG").unwrap()).unwrap();writeln!(f,"held:{}:{}",std::process::id(),t).ok();while fs::read_to_string(&g).unwrap_or_default().trim()=="checkpoint"{thread::sleep(Duration::from_millis(20));}}let s=Command::new(env::var_os("TT_QA_REAL_GIT").unwrap()).args(a).stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).creation_flags(H).status().unwrap();std::process::exit(s.code().unwrap_or(1));}`);
  execFileSync('rustc', [join(scratch, 'git.rs'), '-O', '-o', join(bin, 'git.exe')], { stdio: 'pipe', windowsHide: true });
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
  await Promise.all([writeFile(gate, 'release'), writeFile(release, 'go'), writeFile(fakeLog, ''), writeFile(gitLog, '')]);

  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', root], cwd: bin, env: sanitizedEnvironment(), timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.threadterm));
  const rpc = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
  const snapshot = await rpc('runtime.snapshot');
  await rpc('settings.update', {
    patch: { notifications: { native: false, attention: false, completed: false, sound: false } },
    expectedRevision: snapshot.settings.revision,
    operationId: randomUUID(),
  });

  const plainChat = await createChat(rpc, plain, 'Send trace non-Git');
  const plainOperationId = randomUUID();
  await rpc('chat.send', {
    sessionId: plainChat.session.id, text: 'send trace prompt', operationId: plainOperationId,
    leaseEpoch: plainChat.leaseEpoch,
  });
  if (enabled) {
    await until(async () => (await traceRows()).some(row =>
      row.operationId === plainOperationId && row.stage === 'desktop.request.end'), 'non-Git trace flush');
    const rows = (await traceRows()).filter(row => row.operationId === plainOperationId);
    const runtimeRows = rows.filter(row => row.source === 'runtime');
    ordered(rows, ['desktop.request.begin', 'desktop.request.write', 'desktop.request.end'], 'desktop');
    ordered(rows, [
      'transport.ordered.enqueue', 'transport.ordered.dequeue', 'transport.dispatch.begin',
      'service.chat_send.begin', 'review.checkpoint.begin', 'review.checkpoint.end',
      'persistence.record.begin', 'persistence.record.end', 'provider.handoff.begin',
      'native.stdin_write.begin', 'native.stdin_write.end', 'provider.handoff.end',
      'persistence.complete.begin', 'persistence.complete.end', 'service.chat_send.end',
      'transport.dispatch.end',
    ], 'runtime');
    assert.ok(runtimeRows.some(row => row.stage === 'review.git.exit' && row.outcome === 'error'),
      'non-Git checkpoint must report its bounded Git failure');
    const ids = new Set(rows.map(row => row.requestId).filter(Boolean));
    assert.equal(ids.size, 1, 'non-Git trace must retain one request correlation');
    report.scenarios.nonGit = { records: rows.length, requestId: [...ids][0] };
    report.checks.push('enabled non-Git send emitted correlated desktop/runtime stages in order');
  }

  await until(async () => (await rpc('runtime.snapshot')).sessions
    .find(session => session.id === plainChat.session.id)?.status === 'idle', 'first fake turn completed');
  hostGit(['init']);
  hostGit(['config', 'user.email', 'qa@example.test']);
  hostGit(['config', 'user.name', 'QA']);
  await writeFile(join(plain, 'README.md'), 'send trace QA\n');
  hostGit(['add', '.']);
  hostGit(['commit', '-m', 'base']);
  const gitChat = plainChat;
  const draft = await rpc('chat.draft.read', { sessionId: gitChat.session.id });
  const chatOperationId = randomUUID();
  const draftOperationId = randomUUID();
  await writeFile(gate, 'checkpoint');
  const send = rpc('chat.send', {
    sessionId: gitChat.session.id, text: 'send trace prompt', operationId: chatOperationId,
    leaseEpoch: gitChat.leaseEpoch,
  });
  await until(async () => (await text(gitLog)).includes('held:'), 'Git checkpoint held');
  const save = rpc('chat.draft.save', {
    sessionId: gitChat.session.id, text: 'queued while checkpoint is held', expectedRevision: draft.revision,
    leaseEpoch: gitChat.leaseEpoch, operationId: draftOperationId,
  });
  if (enabled) {
    await until(async () => (await traceRows()).some(row =>
      row.operationId === draftOperationId && row.stage === 'transport.ordered.enqueue' && row.activeMethod === 'chat.send'),
    'queued draft active-ahead trace');
  }
  await Promise.all([send, save]);
  await writeFile(gate, 'release');

  if (enabled) {
    await until(async () => (await traceRows()).some(row =>
      row.operationId === draftOperationId && row.stage === 'desktop.request.end'), 'held-Git trace flush');
    const rows = await traceRows();
    const chatRows = rows.filter(row => row.operationId === chatOperationId);
    const draftRows = rows.filter(row => row.operationId === draftOperationId);
    const chatRequestId = chatRows.find(row => row.stage === 'transport.ordered.enqueue')?.requestId;
    const draftEnqueue = draftRows.find(row => row.stage === 'transport.ordered.enqueue');
    const draftDequeue = draftRows.find(row => row.stage === 'transport.ordered.dequeue');
    const timedOutGit = chatRows.find(row => row.stage === 'review.git.exit' && row.outcome === 'timeout');
    assert.ok(chatRequestId);
    assert.equal(draftEnqueue?.activeRequestId, chatRequestId);
    assert.equal(draftEnqueue?.activeMethod, 'chat.send');
    assert.ok(Number.isSafeInteger(draftDequeue?.queueWaitUs) && draftDequeue.queueWaitUs > 0);
    assert.ok(Number.isSafeInteger(timedOutGit?.durationUs)
      && timedOutGit.durationUs >= 9_000_000 && timedOutGit.durationUs <= 11_000_000,
    `checkpoint timeout duration outside 9-11s: ${timedOutGit?.durationUs}`);
    const runtimeRows = rows.filter(row => row.source === 'runtime').sort((a, b) => a.monotonicUs - b.monotonicUs);
    const position = (operationId, stage) => runtimeRows.findIndex(row => row.operationId === operationId && row.stage === stage);
    assert.ok(position(chatOperationId, 'transport.ordered.dequeue') < position(draftOperationId, 'transport.ordered.enqueue'));
    assert.ok(position(draftOperationId, 'transport.ordered.enqueue') < position(chatOperationId, 'transport.dispatch.end'));
    assert.ok(position(chatOperationId, 'transport.dispatch.end') < position(draftOperationId, 'transport.ordered.dequeue'));
    report.scenarios.heldGit = {
      chatRecords: chatRows.length, draftRecords: draftRows.length,
      activeRequestId: draftEnqueue.activeRequestId, queueWaitUs: draftDequeue.queueWaitUs,
      gitTimeoutUs: timedOutGit.durationUs,
    };
    report.checks.push('held Git reached the real bounded timeout and exposed active-ahead queue timing');
  } else {
    await delay(500);
    assert.equal((await traceRows()).length, 0, 'disabled trace flag must emit no send records');
    report.scenarios.disabled = { records: 0 };
    report.checks.push('unset trace flag emitted no send records across non-Git and held-Git sends');
  }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await writeFile(gate, 'release').catch(() => {});
  if (page) await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  if (app) {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!keep) await rm(scratch, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
