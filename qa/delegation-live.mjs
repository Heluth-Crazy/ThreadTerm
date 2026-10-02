// Live agent-delegation check for task 09-30-agent-delegation (Phase 1 acceptance): the
// target-qa runtime (with its threadterm-v3-mcp beside it) on isolated ThreadTerm data,
// driving the user's normal agent CLIs. One scenario per run — the QA machine is small:
//   node qa/delegation-live.mjs claude-codex   Claude delegates a file edit to Codex (shared folder)
//   node qa/delegation-live.mjs codex-kimi     Codex delegates a reply to Kimi
//   node qa/delegation-live.mjs fanout         Claude runs a Codex and a Kimi delegate at once
//   node qa/delegation-live.mjs relay          Claude answers a Kimi delegate's shell approval (worktree)
//   node qa/delegation-live.mjs codex-claude   Codex answers a Claude delegate's file-write approval
// Never sends browser-opening commands. Afterwards removes the probe's agent history:
// ~/.claude/projects folders, Codex rollouts + state_5/thread_history_1 rows, Kimi
// session folders, index lines, workspace entries (qa/agent-history.mjs). Uses the source
// Claude sidecar (THREADTERM_CLAUDE_SDK_HOST) so providers/claude-sdk/dist stays untouched.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, openSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { connectPeer } from './pipe-client.mjs';
import { removeAgentHistory } from './agent-history.mjs';

const SCENARIOS = ['claude-codex', 'codex-kimi', 'fanout', 'relay', 'codex-claude'];
const scenario = process.argv[2];
if (!SCENARIOS.includes(scenario)) throw Error(`usage: node qa/delegation-live.mjs <${SCENARIOS.join('|')}>`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const exe = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
if (!/runtime[\\/]target-qa[\\/]debug[\\/]threadterm-v3-runtime\.exe$/iu.test(exe)) throw Error(`Refusing non-QA runtime: ${exe}`);
assert.ok(existsSync(join(dirname(exe), 'threadterm-v3-mcp.exe')), 'build threadterm-v3-mcp next to the QA runtime');
const scratch = await mkdtemp(join(tmpdir(), 'tt-deleg-live-'));
const slug = basename(scratch).toLowerCase();
const workspace = join(scratch, `${basename(scratch)}-ws`);
const checks = [];
const note = text => { checks.push(text); console.log(`PASS ${text}`); };
const log = text => console.log(`  … ${text}`);

// The desktop starts the runtime outside any Claude Code session.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(CLAUDECODE|CLAUDE_CODE_(SESSION|ENTRYPOINT|CHILD|MESSAGING|EXECPATH)|CLAUDE_PID|CLAUDE_EFFORT)/.test(key)));
let daemon;
const peers = new Set();

async function start() {
  const data = join(scratch, 'data');
  const pipe = `\\\\.\\pipe\\tt-deleg-live-${randomUUID()}`;
  await mkdir(data, { recursive: true });
  const env = {
    ...baseEnv,
    THREADTERM_V3_DATA: data,
    THREADTERM_V3_USER_DATA: join(scratch, 'user'),
    THREADTERM_V3_PIPE: pipe,
    THREADTERM_CLAUDE_SDK_HOST: join(root, 'providers/claude-sdk/src/main.mjs'),
  };
  const stderr = openSync(join(scratch, 'runtime.log'), 'a');
  daemon = spawn(exe, [], { windowsHide: true, env, stdio: ['ignore', 'ignore', stderr] });
  for (let i = 0; i < 150; i++) {
    try {
      const peer = await connectPeer(`${pipe}-control`);
      await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      const request = peer.request.bind(peer);
      peer.request = (method, params = {}, timeoutMs = 120000) => request(method, params, timeoutMs);
      peers.add(peer);
      return peer;
    } catch { if (daemon.exitCode !== null) throw Error('daemon exited at startup'); await delay(100); }
  }
  throw Error('runtime startup timeout');
}
async function stopDaemon() {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill();
  for (const peer of peers) peer.close();
  peers.clear();
  await delay(500);
}

const textOf = item => item.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('');
const lease = { epoch: 0, renewed: 0, session: undefined };
async function renew(peer, force = false) {
  if (!force && Date.now() - lease.renewed < 10000) return;
  lease.epoch = (await peer.request('session.renew', { sessionId: lease.session, leaseEpoch: lease.epoch })).leaseEpoch;
  lease.renewed = Date.now();
}

async function parentChat(peer, projectId, provider, title) {
  const session = await peer.request('session.create', { projectId, cwd: workspace, title, provider, mode: 'chat', operationId: randomUUID() });
  lease.session = session.id;
  lease.epoch = (await peer.request('session.claim', { sessionId: session.id, clientId: 'qa-delegation-live' })).leaseEpoch;
  lease.renewed = Date.now();
  const state = await peer.request('chat.connect', { sessionId: session.id, leaseEpoch: lease.epoch, operationId: randomUUID() });
  assert.equal(state.phase, 'ready', `parent ${provider} connected`);
  return session;
}

const delegatesOf = (snapshot, parentId) => snapshot.sessions.filter(session => session.delegation?.parentSessionId === parentId);

/** One parent turn; logs every delegate state change; answers the parent's own non-delegation approvals once. */
async function run(peer, parent, text, minutes = 12) {
  await renew(peer, true);
  const before = (await peer.request('chat.read', { sessionId: parent.id })).length;
  const { turnId } = await peer.request('chat.send', { sessionId: parent.id, text, leaseEpoch: lease.epoch, operationId: randomUUID() });
  const parentApprovals = [];
  const seenStates = new Map();
  const deadline = Date.now() + minutes * 60000;
  for (;;) {
    if (Date.now() > deadline) throw Error('parent turn timed out');
    await renew(peer);
    const snapshot = await peer.request('runtime.snapshot');
    for (const delegate of delegatesOf(snapshot, parent.id)) {
      const key = `${delegate.delegation.state}/${delegate.activity?.state ?? '-'}`;
      if (seenStates.get(delegate.id) !== key) { seenStates.set(delegate.id, key); log(`delegate ${delegate.provider} "${delegate.title}": delegation=${delegate.delegation.state} activity=${delegate.activity?.state ?? '-'}`); }
    }
    const items = await peer.request('chat.read', { sessionId: parent.id });
    const pending = items.flatMap(item => item.parts.filter(part => part.type === 'approval' && part.status === 'pending').map(part => ({ item, part })));
    for (const card of pending) {
      if (parentApprovals.some(seen => seen.part.approvalId === card.part.approvalId)) continue;
      parentApprovals.push(card);
      log(`parent approval: ${card.part.data?.title ?? '?'}`);
      const choice = (card.part.data?.choices ?? []).find(candidate => candidate.kind === 'allow' && candidate.scope === 'once') ?? card.part.data?.choices?.[0];
      if (choice) await peer.request('chat.approve', { sessionId: parent.id, turnId: card.item.turnId, approvalId: card.part.approvalId, choiceId: choice.choiceId, leaseEpoch: lease.epoch, operationId: randomUUID() });
    }
    // Done when this turn's own activity has ended (status alone is still "idle"
    // for a moment after chat.send, before the provider reports the turn).
    const activity = snapshot.sessions.find(value => value.id === parent.id)?.activity;
    const ended = activity?.turnId === turnId && (activity.state === 'idle' || activity.state === 'awaiting_input');
    if (ended && !pending.length) {
      const turnItems = items.slice(before);
      for (const item of turnItems) for (const part of item.parts) {
        if (part.type === 'tool') log(`parent tool ${part.toolName ?? '?'} [${part.status ?? '-'}]`);
        if (part.type === 'error') log(`parent error: ${String(part.text).slice(0, 200)}`);
      }
      log(`parent reply: ${turnItems.filter(item => item.role === 'assistant').map(textOf).join(' ').replace(/\s+/g, ' ').slice(0, 300)}`);
      return { turnId, items: turnItems, parentApprovals, snapshot };
    }
    await delay(1500);
  }
}

const noDelegationToolApprovals = turn => {
  const asked = turn.parentApprovals.filter(card => /threadterm|delegate_/i.test(JSON.stringify(card.part.data?.title ?? '')));
  assert.equal(asked.length, 0, 'the parent is never asked about its own delegation tools');
};
const replyOf = turn => turn.items.filter(item => item.role === 'assistant').map(textOf).join('\n');

const TOOLS_PREAMBLE = 'You have ThreadTerm delegation tools from the "threadterm" MCP server (delegate_start, delegate_status, delegate_wait, delegate_respond, delegate_result). This is an automated test: follow the steps exactly and do not do the delegated work yourself.';

async function scenarioClaudeCodex(peer, projectId) {
  const parent = await parentChat(peer, projectId, 'claude', 'QA delegation parent (Claude)');
  const turn = await run(peer, parent, `${TOOLS_PREAMBLE}
1) Call delegate_start with agent "codex", workspace "shared", title "QA codex delegate" and prompt "Create a file named delegated.txt in the current folder containing exactly the text DELEGATED-OK. Then reply with exactly DONE-CODEX."
2) Call delegate_wait repeatedly until the delegate is completed, failed or cancelled. If it has pendingRequests, answer each with delegate_respond using an allow choice.
3) Call delegate_result and reply with the delegate's finalAnswer and its changedFiles.`);
  noDelegationToolApprovals(turn);
  const [child, ...extra] = delegatesOf(turn.snapshot, parent.id);
  assert.ok(child && !extra.length, 'exactly one delegate');
  assert.equal(child.provider, 'codex');
  assert.equal(child.delegation.state, 'completed', `delegate finished: ${child.delegation.state}`);
  const prompt = (await peer.request('chat.read', { sessionId: child.id }))[0];
  assert.match(textOf(prompt), /delegated\.txt/, 'the delegate shows the prompt as its first message');
  assert.equal(readFileSync(join(workspace, 'delegated.txt'), 'utf8').trim(), 'DELEGATED-OK');
  assert.match(replyOf(turn), /DONE-CODEX/);
  note(`Claude → Codex: delegate "${child.title}" completed, delegated.txt written, parent reported: ${replyOf(turn).replace(/\s+/g, ' ').slice(0, 160)}`);
}

async function scenarioCodexKimi(peer, projectId) {
  const parent = await parentChat(peer, projectId, 'codex', 'QA delegation parent (Codex)');
  const turn = await run(peer, parent, `${TOOLS_PREAMBLE}
1) Call delegate_start with agent "kimi", title "QA kimi delegate" and prompt "Reply with exactly KIMI-DELEGATE-OK and nothing else. Do not use any tools."
2) Call delegate_wait repeatedly until the delegate is completed, failed or cancelled.
3) Call delegate_result and reply with exactly the delegate's finalAnswer.`);
  noDelegationToolApprovals(turn);
  const [child, ...extra] = delegatesOf(turn.snapshot, parent.id);
  assert.ok(child && !extra.length, 'exactly one delegate');
  assert.equal(child.provider, 'kimi');
  assert.equal(child.delegation.state, 'completed', `delegate finished: ${child.delegation.state}`);
  assert.match(replyOf(turn), /KIMI-DELEGATE-OK/);
  note(`Codex → Kimi: delegate completed; Codex relayed: ${replyOf(turn).replace(/\s+/g, ' ').slice(0, 120)}`);
}

async function scenarioFanout(peer, projectId) {
  const parent = await parentChat(peer, projectId, 'claude', 'QA delegation fan-out (Claude)');
  const turn = await run(peer, parent, `${TOOLS_PREAMBLE}
1) Start two delegates before waiting on either: delegate_start with agent "codex", title "QA fan-out codex", prompt "Reply with exactly FAN-CODEX-OK and nothing else. Do not use any tools."; and delegate_start with agent "kimi", title "QA fan-out kimi", prompt "Reply with exactly FAN-KIMI-OK and nothing else. Do not use any tools."
2) Call delegate_wait repeatedly until both are completed, failed or cancelled.
3) Call delegate_result for each and reply with both finalAnswers.`);
  noDelegationToolApprovals(turn);
  const children = delegatesOf(turn.snapshot, parent.id);
  assert.deepEqual(children.map(child => child.provider).sort(), ['codex', 'kimi']);
  for (const child of children) assert.equal(child.delegation.state, 'completed', `${child.provider} finished: ${child.delegation.state}`);
  const reply = replyOf(turn);
  assert.match(reply, /FAN-CODEX-OK/);
  assert.match(reply, /FAN-KIMI-OK/);
  const started = children.map(child => Date.parse(child.createdAt));
  note(`fan-out: Codex and Kimi delegates both completed (started ${Math.abs(started[0] - started[1]) / 1000}s apart); parent reply has both answers`);
}

async function scenarioRelay(peer, projectId) {
  const parent = await parentChat(peer, projectId, 'claude', 'QA delegation relay (Claude)');
  const turn = await run(peer, parent, `${TOOLS_PREAMBLE}
1) Call delegate_start with agent "kimi", workspace "worktree", title "QA kimi worktree delegate" and prompt "Use your shell tool to run exactly: git branch --show-current  Then reply with exactly its output and nothing else."
2) Call delegate_wait repeatedly until the delegate is completed, failed or cancelled. The delegate will ask permission to run the shell command: when delegate_wait reports pendingRequests, answer each with delegate_respond choosing its allow-once choice.
3) Call delegate_result and reply with the delegate's finalAnswer.`);
  noDelegationToolApprovals(turn);
  const [child, ...extra] = delegatesOf(turn.snapshot, parent.id);
  assert.ok(child && !extra.length, 'exactly one delegate');
  assert.equal(child.provider, 'kimi');
  assert.equal(child.delegation.workspace, 'worktree');
  assert.match(child.delegation.branch ?? '', /^threadterm\/delegate-kimi-[0-9a-f]{8}$/);
  assert.equal(child.delegation.state, 'completed', `delegate finished: ${child.delegation.state}`);
  const leaf = child.delegation.branch.slice('threadterm/'.length);
  assert.ok(existsSync(join(`${workspace}.delegates`, leaf.replace('delegate-', ''))), 'worktree folder beside the repository');
  const approvals = (await peer.request('chat.read', { sessionId: child.id })).flatMap(item => item.parts.filter(part => part.type === 'approval'));
  assert.ok(approvals.length >= 1, 'the delegate asked for permission');
  for (const part of approvals) {
    assert.equal(part.data?.delegation?.route, 'parent', 'routed to the parent agent');
    assert.equal(part.status, 'resolved', 'answered');
  }
  const inbox = turn.snapshot.inbox.filter(item => item.sessionId === child.id && item.kind === 'approval');
  assert.equal(inbox.length, 0, 'the user was not notified');
  assert.match(replyOf(turn), new RegExp(child.delegation.branch.replace(/[/]/g, '\\/')));
  note(`relay: Kimi's ${approvals.length} shell approval(s) went to Claude, which answered; no Inbox entry; worktree branch ${child.delegation.branch} reported back`);
}

async function scenarioCodexClaude(peer, projectId) {
  const parent = await parentChat(peer, projectId, 'codex', 'QA delegation parent (Codex → Claude)');
  const turn = await run(peer, parent, `${TOOLS_PREAMBLE}
1) Call delegate_start with agent "claude", workspace "shared", title "QA claude delegate" and prompt "Use your Write tool to create a file named claude-delegated.txt in the current folder containing exactly CLAUDE-DELEGATED-OK. Then reply with exactly DONE-CLAUDE and nothing else."
2) Call delegate_wait repeatedly until the delegate is completed, failed or cancelled. The delegate will ask permission to write the file: when delegate_wait reports pendingRequests, answer each request once with delegate_respond choosing its allow-once choice.
3) Call delegate_result and reply with the delegate's finalAnswer.`);
  noDelegationToolApprovals(turn);
  const [child, ...extra] = delegatesOf(turn.snapshot, parent.id);
  assert.ok(child && !extra.length, 'exactly one delegate');
  assert.equal(child.provider, 'claude');
  assert.equal(child.delegation.state, 'completed', `delegate finished: ${child.delegation.state}`);
  const approvals = (await peer.request('chat.read', { sessionId: child.id })).flatMap(item => item.parts.filter(part => part.type === 'approval'));
  assert.ok(approvals.length >= 1, 'the Claude delegate asked for permission');
  for (const part of approvals) {
    assert.equal(part.data?.delegation?.route, 'parent', 'routed to the parent agent');
    // Before the Claude adapter settled answered cards, this stayed pending until the turn ended → expired.
    assert.equal(part.status, 'resolved', `the answered Claude card is settled, not ${part.status}`);
  }
  const responds = turn.items.flatMap(item => item.parts).filter(part => part.type === 'tool' && /delegate_respond/.test(`${part.toolName} ${part.data?.tool ?? ''}`));
  log(`parent delegate_respond calls: ${responds.length}`);
  assert.equal(responds.length, approvals.length, 'the parent answered each request once (no stale request kept it busy)');
  assert.equal(turn.snapshot.inbox.filter(item => item.sessionId === child.id && item.kind === 'approval').length, 0, 'the user was not notified');
  assert.equal(readFileSync(join(workspace, 'claude-delegated.txt'), 'utf8').trim(), 'CLAUDE-DELEGATED-OK');
  assert.match(replyOf(turn), /DONE-CLAUDE/);
  note(`Codex → Claude: Claude's ${approvals.length} Write approval(s) went to Codex, answered once each and settled (resolved); file written; Codex relayed: ${replyOf(turn).replace(/\s+/g, ' ').slice(0, 120)}`);
}

let failed;
try {
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'README.md'), '# Delegation QA\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=ThreadTerm QA', '-c', 'user.email=qa@threadterm.invalid', ...args], { cwd: workspace, stdio: 'pipe', windowsHide: true });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'QA fixture');
  const peer = await start();
  const project = await peer.request('project.add', { path: workspace, operationId: randomUUID() });
  const providers = await peer.request('provider.list');
  log(`providers: ${providers.filter(p => p.chat).map(p => `${p.id}(${p.auth ?? '?'})`).join(', ')}`);
  await ({ 'claude-codex': scenarioClaudeCodex, 'codex-kimi': scenarioCodexKimi, fanout: scenarioFanout, relay: scenarioRelay, 'codex-claude': scenarioCodexClaude })[scenario](peer, project.id);
  console.log(JSON.stringify({ scenario, passed: true, checks }, null, 2));
} catch (error) {
  failed = error;
  console.log(`FAIL ${scenario}: ${error.stack ?? error}`);
  if (existsSync(join(scratch, 'runtime.log'))) console.log(`runtime log tail:\n${readFileSync(join(scratch, 'runtime.log'), 'utf8').split('\n').slice(-25).join('\n')}`);
} finally {
  await stopDaemon();
  // Closed CLIs may still be writing for a few seconds (the Claude SDK allows ~7 s on Windows).
  await delay(8000);
  removeAgentHistory(slug);
  await rm(scratch, { recursive: true, force: true }).catch(() => console.log(`QA scratch left at ${scratch}`));
  if (failed) process.exitCode = 1;
}
