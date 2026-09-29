// Real runtime (isolated build, private pipe, temp data): one slow request on the control connection must not
// hold up reads or terminal control, while other requests keep their arrival order behind it.
// Run with THREADTERM_V3_RUNTIME_BIN=<v3>/runtime/target-qa/debug/threadterm-v3-runtime.exe.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectPeer } from './pipe-client.mjs';

const exe = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-request-lanes-'));
const data = join(scratch, 'data'), repo = join(scratch, 'repo'), remote = join(scratch, 'remote.git');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
const STALL_MS = 6000;
await mkdir(repo);
git(scratch, 'init', '--bare', '-q', remote);
git(repo, 'init', '-q');
git(repo, 'config', 'user.email', 'qa@example.invalid');
git(repo, 'config', 'user.name', 'Lanes QA');
await writeFile(join(repo, 'a.txt'), 'a\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'init');
git(repo, 'remote', 'add', 'origin', remote);
// A fetch runs this instead of git-upload-pack: a deterministic stall with no network.
git(repo, 'config', 'remote.origin.uploadpack', `sleep ${STALL_MS / 1000}; exit 1 #`);

const pipe = '\\\\.\\pipe\\threadterm-v3-lanes-' + randomUUID();
const delay = ms => new Promise(done => setTimeout(done, ms));
const daemon = spawn(exe, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(scratch, 'user-data'), THREADTERM_V3_PIPE: pipe } });
let peer;
try {
  for (let attempt = 0; attempt < 150 && !peer; attempt++) {
    try { const candidate = await connectPeer(`${pipe}-control`); await candidate.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim()); peer = candidate; }
    catch { if (daemon.exitCode !== null) throw new Error('runtime exited at startup'); await delay(100); }
  }
  assert.ok(peer, 'isolated runtime did not accept a control connection');
  // Replies may now arrive out of order, so route frames by id (pipe-client's request() takes one reply at a time).
  const waiting = new Map();
  let open = true;
  void (async () => {
    while (open) {
      let message;
      try { message = JSON.parse(await peer.next(120_000)); } catch { break; }
      if (typeof message.event === 'string') continue;
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  })();
  const t0 = Date.now();
  const send = (method, params = {}) => new Promise(done => {
    const id = randomUUID();
    waiting.set(id, message => done({ method, ok: !message.error, error: message.error?.code, result: message.result, finished: Date.now() - t0 }));
    peer.json({ v: 1, id, method, params });
  });

  const added = await send('project.add', { path: repo, name: 'Lanes QA', operationId: randomUUID() });
  assert.ok(added.ok && added.result?.id, `project.add failed: ${added.error}`);
  const projectId = added.result.id;

  const fetchStarted = Date.now() - t0;
  const fetch = send('git.fetch', { projectId, operationId: randomUUID() });
  await delay(400); // the fetch now occupies the ordered lane
  const probes = await Promise.all([
    send('git.status', { projectId }),
    send('filesystem.list', { projectId, path: '' }),
    send('git.log', { projectId, limit: 5 }),
    send('terminal.read', { sessionId: 'no-such-session', tail: true, limit: 1 }),
    send('terminal.input', { sessionId: 'no-such-session', data: 'x', leaseEpoch: 1 }),
  ]);
  const health = send('runtime.health');
  const fetched = await fetch;
  const ordered = await health;
  const report = { fetch: { ...fetched, result: undefined, started: fetchStarted }, probes: probes.map(({ method, ok, error, finished }) => ({ method, ok, error, finished })), health: { ok: ordered.ok, finished: ordered.finished } };
  console.log(JSON.stringify(report, null, 1));

  assert.ok(fetched.finished - fetchStarted >= STALL_MS - 500, 'the fetch stall must be real for this test to mean anything');
  assert.equal(probes[0].ok, true, 'git.status answers during the fetch');
  assert.equal(probes[0].result?.branch !== undefined, true);
  assert.equal(probes[1].ok, true, 'filesystem.list answers during the fetch');
  assert.equal(probes[2].ok, true, 'git.log answers during the fetch');
  assert.equal(probes[3].error, 'session_not_found', 'terminal.read reaches the runtime during the fetch');
  for (const probe of probes) {
    assert.ok(probe.finished < fetched.finished - 2000, `${probe.method} waited for the slow fetch (${probe.finished} ms vs fetch ${fetched.finished} ms)`);
  }
  assert.equal(ordered.ok, true);
  assert.ok(ordered.finished >= fetched.finished, 'ordered requests keep their arrival order behind the slow one');
  console.log(JSON.stringify({ passed: true, checks: ['reads (git.status, filesystem.list, git.log, terminal.read) answer during a 6 s fetch', 'terminal control (terminal.input) answers during the fetch', 'an ordered request (runtime.health) still waits for the earlier ordered fetch'] }));
  open = false;
} finally {
  if (peer) {
    try { peer.json({ v: 1, id: randomUUID(), method: 'runtime.shutdown', params: { operationId: randomUUID() } }); } catch { /* already closed */ }
  }
  for (let attempt = 0; daemon.exitCode === null && attempt < 50; attempt++) await delay(100);
  if (daemon.exitCode === null) daemon.kill();
  peer?.close();
}
