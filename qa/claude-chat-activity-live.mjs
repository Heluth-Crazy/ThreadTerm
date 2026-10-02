// Live check that Claude Chat feeds the branch-tree session activity correctly: an
// answered turn asks for attention (awaiting_input); a turn the user stops settles to
// idle. target-qa runtime, isolated ThreadTerm data, the caller's normal Claude
// configuration, two short model turns.
//   node qa/claude-chat-activity-live.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { connectPeer } from './pipe-client.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const exe = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
if (!/runtime[\\/]target-qa[\\/]debug[\\/]threadterm-v3-runtime\.exe$/iu.test(exe)) throw Error(`Refusing non-QA runtime: ${exe}`);
const scratch = await mkdtemp(join(tmpdir(), 'tt-claude-activity-'));
const workspace = join(scratch, 'workspace');
await mkdir(workspace, { recursive: true });
const data = join(scratch, 'data');
const pipe = `\\\\.\\pipe\\tt-claude-activity-${randomUUID()}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(CLAUDECODE|CLAUDE_CODE_(SESSION|ENTRYPOINT|CHILD|MESSAGING|EXECPATH)|CLAUDE_PID|CLAUDE_EFFORT)/.test(key)));
const checks = [];
const note = text => { checks.push(text); console.log(`PASS ${text}`); };
await mkdir(data, { recursive: true });
const daemon = spawn(exe, [], { windowsHide: true, env: { ...env, THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(scratch, 'user'), THREADTERM_V3_PIPE: pipe }, stdio: 'ignore' });
let peer;
try {
  for (let i = 0; i < 150 && !peer; i++) {
    try {
      const candidate = await connectPeer(`${pipe}-control`);
      await candidate.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      peer = candidate;
    } catch { if (daemon.exitCode !== null) throw Error('daemon exited at startup'); await delay(100); }
  }
  const request = (method, params = {}) => peer.request(method, params, 120000);
  const session = await request('session.create', { cwd: workspace, title: 'QA claude activity', provider: 'claude', mode: 'chat', operationId: randomUUID() });
  let lease = (await request('session.claim', { sessionId: session.id, clientId: 'qa-claude-activity' })).leaseEpoch;
  assert.equal((await request('chat.connect', { sessionId: session.id, leaseEpoch: lease, operationId: randomUUID() })).phase, 'ready');
  const record = async () => (await request('runtime.snapshot')).sessions.find(value => value.id === session.id);
  const waitFor = async (predicate, label, ms = 180000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      lease = (await request('session.renew', { sessionId: session.id, leaseEpoch: lease })).leaseEpoch;
      const current = await record();
      if (predicate(current)) return current;
      if (Date.now() > deadline) throw Error(`timed out waiting for ${label}: status=${current.status} activity=${JSON.stringify(current.activity)}`);
      await delay(300);
    }
  };
  note(`fresh chat activity: ${JSON.stringify((await record()).activity ?? null)}`);

  // 1. An answered turn becomes "needs you" (awaiting_input).
  await request('chat.send', { sessionId: session.id, text: 'Reply with exactly DONE-1 and nothing else. Do not use any tools.', leaseEpoch: lease, operationId: randomUUID() });
  let seenRunning = false;
  let current = await waitFor(value => { seenRunning ||= value.activity?.state === 'running'; return value.status === 'idle'; }, 'first turn');
  assert.ok(seenRunning, 'the turn showed running');
  assert.equal(current.activity?.state, 'awaiting_input');
  note(`answered turn: running -> ${current.activity.state}`);

  // 2. A turn the user stops settles to idle, not "needs you".
  const { turnId } = await request('chat.send', { sessionId: session.id, text: 'Write the numbers from 1 to 400, one per line, with no other text. Do not use any tools.', leaseEpoch: lease, operationId: randomUUID() });
  await waitFor(value => value.activity?.state === 'running' && value.activity?.turnId === turnId, 'second turn running');
  await delay(2500);
  await request('chat.cancel', { sessionId: session.id, turnId, leaseEpoch: lease });
  current = await waitFor(value => value.status === 'idle', 'stopped turn');
  assert.equal(current.activity?.state, 'idle', `stopped turn activity: ${JSON.stringify(current.activity)}`);
  note(`stopped turn: running -> ${current.activity.state} (reason ${current.activity.reason ?? '-'})`);
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  if (daemon.exitCode === null) daemon.kill();
  peer?.close();
  // The closed CLI may keep writing for a few seconds; Windows can change the name's case.
  await delay(8000);
  const projects = join(homedir(), '.claude', 'projects');
  const slug = basename(scratch).toLowerCase();
  for (const dir of existsSync(projects) ? await readdir(projects) : []) {
    if (dir.toLowerCase().includes(slug)) { await rm(join(projects, dir), { recursive: true, force: true }); console.log(`removed Claude history ${dir}`); }
  }
  await rm(scratch, { recursive: true, force: true }).catch(() => console.log(`QA scratch left at ${scratch}`));
}
