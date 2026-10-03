// Live agent-delegation check for task 09-30-agent-delegation (Phase 1 acceptance): the
// target-qa runtime (with its threadterm-v3-mcp beside it) on isolated ThreadTerm data,
// driving the user's normal agent CLIs. One scenario per run — the QA machine is small:
//   node qa/delegation-live.mjs claude-codex   Claude delegates a file edit to Codex (shared folder)
//   node qa/delegation-live.mjs codex-kimi     Codex delegates a reply to Kimi
//   node qa/delegation-live.mjs fanout         Claude runs a Codex and a Kimi delegate at once
//   node qa/delegation-live.mjs relay          Claude answers a Kimi delegate's shell approval (worktree)
//   node qa/delegation-live.mjs codex-claude   Codex answers a Claude delegate's file-write approval
//   node qa/delegation-live.mjs handoff        Claude writes its own brief for a medium Codex task (10-02-delegation-handoff)
//   node qa/delegation-live.mjs eval <1-6> <direct|template> [codex|claude] [--dry]
//        validation tests 1–6 of 10-02-delegation-handoff (design.md). 1–3: a Claude parent talks with the user
//        over several turns, then writes a Codex delegate's brief itself (`direct` runs the f8a90ae build copied
//        to runtime/target-qa/baseline). 4–6: hand-written prompts (prose vs the template brief, same
//        assignment) passed through verbatim to the given agent. Results: qa/results/delegation-handoff/.
// Never sends browser-opening commands. Afterwards removes the probe's agent history:
// ~/.claude/projects folders, Codex rollouts + state_5/thread_history_1 rows, Kimi
// session folders, index lines, workspace entries (qa/agent-history.mjs). Uses the source
// Claude sidecar (THREADTERM_CLAUDE_SDK_HOST) so providers/claude-sdk/dist stays untouched.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { connectPeer } from './pipe-client.mjs';
import { removeAgentHistory } from './agent-history.mjs';

const SCENARIOS = ['claude-codex', 'codex-kimi', 'fanout', 'relay', 'codex-claude', 'handoff', 'eval'];
const scenario = process.argv[2];
if (!SCENARIOS.includes(scenario)) throw Error(`usage: node qa/delegation-live.mjs <${SCENARIOS.join('|')}>`);
const evalArgs = process.argv.slice(3).filter(arg => !arg.startsWith('--'));
const [evalTest, evalMode, evalAgent = 'codex'] = [Number(evalArgs[0]), evalArgs[1], evalArgs[2]];
if (scenario === 'eval' && !(evalTest >= 1 && evalTest <= 6 && ['direct', 'template'].includes(evalMode) && ['codex', 'claude'].includes(evalAgent))) {
  throw Error('usage: node qa/delegation-live.mjs eval <1-6> <direct|template> [codex|claude] [--dry]');
}
// `--dry`: print what a run would send and score the untouched fixture; no runtime, no agents.
const dry = scenario === 'eval' && process.argv.includes('--dry');
// Parent-side tests compare the pre-step-1 guidance (f8a90ae build) with the current one.
const baseline = scenario === 'eval' && evalTest <= 3 && evalMode === 'direct';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const exe = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, `runtime/target-qa/${baseline ? 'baseline' : 'debug'}/threadterm-v3-runtime.exe`);
if (!/runtime[\\/]target-qa[\\/](debug|baseline)[\\/]threadterm-v3-runtime\.exe$/iu.test(exe)) throw Error(`Refusing non-QA runtime: ${exe}`);
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

/** One parent turn; logs every delegate state change; answers the parent's own non-delegation approvals once (allow, or deny in setup turns). */
async function run(peer, parent, text, minutes = 12, { deny = false } = {}) {
  const started = Date.now();
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
      log(`parent approval${deny ? ' (denied)' : ''}: ${card.part.data?.title ?? '?'}`);
      const choices = card.part.data?.choices ?? [];
      const choice = deny ? choices.find(candidate => candidate.kind === 'deny') : choices.find(candidate => candidate.kind === 'allow' && candidate.scope === 'once') ?? choices[0];
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
      return { turnId, items: turnItems, parentApprovals, snapshot, seconds: Math.round((Date.now() - started) / 1000) };
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

// Task 10-02-delegation-handoff step 1: the user states a medium task in their own words and the
// parent writes the delegate's prompt itself, guided only by the MCP server's recommended brief.
const HANDOFF_HEADINGS = ["User's words", 'Assignment', 'Constraints', 'Acceptance criteria', 'Deliverable', 'Context', 'Open questions'];

async function scenarioHandoff(peer, projectId) {
  const git = (...args) => execFileSync('git', ['-c', 'user.name=ThreadTerm QA', '-c', 'user.email=qa@threadterm.invalid', ...args], { cwd: workspace, encoding: 'utf8', windowsHide: true });
  await writeFile(join(workspace, 'greet.js'), 'function greet(name) {\n  return `Hello, ${name}!`;\n}\n\nmodule.exports = { greet };\n');
  await writeFile(join(workspace, 'check.js'), "const { greet, farewell } = require('./greet.js');\nif (greet('Ada') !== 'Hello, Ada!') throw Error('greet() changed');\nif (typeof farewell !== 'function' || farewell('Ada') !== 'Goodbye, Ada!') throw Error('farewell() missing or wrong');\nconsole.log('ALL-OK');\n");
  git('add', '.'); git('commit', '-q', '-m', 'QA handoff fixture');
  const commits = () => git('rev-list', '--count', 'HEAD').trim();
  const before = commits();
  const parent = await parentChat(peer, projectId, 'claude', 'QA delegation handoff (Claude)');
  const turn = await run(peer, parent, `You have ThreadTerm delegation tools from the "threadterm" MCP server. This is an automated test: hand the task below to one Codex delegate (agent "codex", workspace "shared") instead of doing it yourself, writing its prompt yourself; wait until it is completed, failed or cancelled, then tell me the result.

The task: greet.js exports greet(name). Add a farewell(name) function next to it that returns "Goodbye, <name>!" and export it as well. Leave greet() exactly as it is. Don't commit, and don't touch README.md or create any other files. When it's done, \`node check.js\` must print ALL-OK. I only need a two-line summary of the change back.`);
  noDelegationToolApprovals(turn);
  const [child, ...extra] = delegatesOf(turn.snapshot, parent.id);
  assert.ok(child && !extra.length, 'exactly one delegate');
  assert.equal(child.provider, 'codex');
  assert.equal(child.delegation.state, 'completed', `delegate finished: ${child.delegation.state}`);
  const brief = textOf((await peer.request('chat.read', { sessionId: child.id }))[0]);
  console.log(`----- the delegate's prompt, written by the parent -----\n${brief}\n-----`);
  const headings = HANDOFF_HEADINGS.filter(heading => new RegExp(`^#+\\s*${heading}`, 'im').test(brief));
  const tags = ['[user]', '[inferred]', '[verified]'].filter(tag => brief.includes(tag));
  const verbatim = brief.includes('Leave greet() exactly as it is.');
  const conflictNote = /report the conflict/i.test(brief);
  // The request to delegate was said to the parent; quoted to the delegate it reads as "delegate this" (validation test 1).
  const metaQuoted = brief.includes('instead of doing it yourself');
  log(`brief: ${brief.length} chars; sections: ${headings.join(', ') || 'none'}; tags: ${tags.join(' ') || 'none'}; user words verbatim: ${verbatim}; conflict note: ${conflictNote}; delegation request quoted: ${metaQuoted}`);
  assert.equal(execFileSync(process.execPath, ['check.js'], { cwd: workspace, encoding: 'utf8', windowsHide: true }).trim(), 'ALL-OK');
  assert.equal(git('status', '--porcelain').trim(), 'M greet.js', 'only greet.js changed (README.md untouched, no new files)');
  assert.equal(commits(), before, 'the delegate did not commit');
  assert.ok(headings.includes('Assignment') && headings.includes('Constraints'), 'the parent briefed the delegate with the recommended sections');
  note(`handoff: Claude briefed Codex with ${headings.length}/${HANDOFF_HEADINGS.length} template sections (tags: ${tags.join(' ') || 'none'}; verbatim: ${verbatim}; conflict note: ${conflictNote}); check.js ALL-OK, only greet.js changed, no commit; parent reported: ${replyOf(turn).replace(/\s+/g, ' ').slice(0, 160)}`);
}

// Validation tests 1–6 (10-02-delegation-handoff design.md), one test × mode × receiving agent per run.
// Scores are recorded, not asserted: a run fails only when it is not a valid sample (not exactly one
// completed delegate, or a fixed prompt the parent did not pass through verbatim).
let evalRecord;
const GREET_JS = 'function greet(name) {\n  return `Hello, ${name}!`;\n}\n\nmodule.exports = { greet };\n';
const STATS_JS = [
  'function mean(values) {', '  return values.reduce((sum, value) => sum + value, 0) / (values.length - 1);', '}', '',
  'function max(values) {', '  return Math.min(...values);', '}', '',
  'function median(values) {', '  const middle = Math.floor(values.length / 2);',
  '  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;', '}', '',
  'module.exports = { mean, max, median };', '',
].join('\n');
const SLUG_FILES = {
  'vendor/slugify.js': "module.exports = function slugify(text) {\n  return text.toLowerCase().replace(/ /g, '-');\n};\n",
  'app.js': "const slugify = require('./vendor/slugify.js');\n\nfunction postUrl(title) {\n  return '/posts/' + slugify(title);\n}\n\nmodule.exports = { postUrl };\n",
  'check.js': "const { postUrl } = require('./app.js');\nconst url = postUrl('Hello, World!');\nif (url !== '/posts/hello-world') throw Error('postUrl(\"Hello, World!\") returned ' + url);\nconsole.log('ALL-OK');\n",
};
const TOOLS_NOTE = 'You have ThreadTerm delegation tools from the "threadterm" MCP server.';
const TO_CODEX = 'one Codex delegate (agent "codex", workspace "shared") instead of doing it yourself, writing its prompt yourself; wait until it is completed, failed or cancelled, then tell me the result.';
const FAREWELL_CHECK = `node -e "console.log(require('./greet.js').farewell('Ada'))"`;
const FAREWELL = 'Add a farewell(name) function to greet.js that returns "Goodbye, <name>!"';
/** The recommended brief (mcp_delegation.rs `handoff_guide!`) for the delegate-side tests. */
const brief = (user, assignment, deliverable) => [
  "## User's words (verbatim, oldest first; later ones win)", `"${user}"`, '',
  '## Assignment (your part only)', ...assignment, '',
  '## Constraints (must / must not)', "- Don't commit.", '',
  '## Acceptance criteria + how to verify', `- \`${FAREWELL_CHECK}\` prints \`Goodbye, Ada!\`.`, '',
  '## Deliverable (what to return)', `- ${deliverable[0].toUpperCase()}${deliverable.slice(1)}`, '',
  "The user's words were said to the delegating agent and show what the user wants; your task is the Assignment. Say which [inferred] items you did or skipped. If the Assignment seems to conflict with the user's words, do the part that clearly doesn't conflict and report the conflict.",
].join('\n');
/** The same assignment as a free-form prompt, as a parent would write it without the template. */
const prose = (task, deliverable) => `${task} Don't commit. Verify with ${FAREWELL_CHECK} (it should print Goodbye, Ada!). Reply with ${deliverable}`;
const nodeJson = code => {
  try {
    return JSON.parse(execFileSync(process.execPath, ['-e', code], { cwd: workspace, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    return { error: String(error.stderr || error.message).split('\n').find(line => /^\s*\w*Error\b/.test(line))?.trim().slice(0, 200) ?? 'failed' };
  }
};
const greetState = () => nodeJson("const m = require('./greet.js'); console.log(JSON.stringify({ greet: typeof m.greet === 'function' ? m.greet('Ada') : null, farewell: typeof m.farewell === 'function' ? m.farewell('Ada') : null, arity: m.farewell?.length ?? null, hello: typeof m.hello === 'function' }))");

const EVAL_TESTS = {
  1: {
    name: 'correction',
    files: { 'greet.js': GREET_JS },
    setup: [
      "I want to extend greet.js: add a farewell(name, formal) function next to greet() that returns \"Goodbye, <name>!\", or \"Farewell, <name>.\" when formal is true, and export it. Don't change any files yet; just confirm in one sentence.",
      "Change of plan: drop the formal variant entirely, so farewell takes only name, and make it return \"Bye, <name>!\" instead of \"Goodbye, <name>!\". Still don't change anything; one sentence is enough.",
    ],
    ask: `${TOOLS_NOTE} Now hand the farewell task to ${TO_CODEX}`,
    score: () => {
      const state = greetState(), source = readFileSync(join(workspace, 'greet.js'), 'utf8');
      return { ...state, latestFollowed: state.farewell === 'Bye, Ada!', formalDropped: state.arity === 1 && !/formal|Farewell,/.test(source), greetKept: state.greet === 'Hello, Ada!' };
    },
  },
  2: {
    name: 'reference',
    files: { 'stats.js': STATS_JS },
    setup: ["Review stats.js and list the bugs you find as a numbered list, one bug per item, in the order they appear in the file (ignore input validation such as empty arrays). Don't change any files."],
    ask: `${TOOLS_NOTE} Hand fixing the second issue you found to ${TO_CODEX} Only that issue; leave the others for later.`,
    score: ({ setupReplies }) => {
      const state = nodeJson("const s = require('./stats.js'); console.log(JSON.stringify({ mean: s.mean([1, 2, 3]), max: s.max([1, 5, 3]), median: s.median([3, 1, 2]) }))");
      const fixed = { mean: state.mean === 2, max: state.max === 5, median: state.median === 2 };
      const secondItem = setupReplies[0].split('\n').find(line => /^\s*(\*\*)?2[.)]/.test(line))?.trim().slice(0, 200) ?? null;
      return { secondItem, fixed, onlyMaxFixed: fixed.max && !fixed.mean && !fixed.median, error: state.error };
    },
  },
  3: {
    name: 'standing constraint',
    files: SLUG_FILES,
    setup: [
      'Ground rules for this whole session: never commit, and never edit anything under vendor/ (those are pinned third-party copies that get overwritten on update). Just acknowledge in one sentence.',
      "What does app.js do? One sentence; don't change anything.",
    ],
    ask: `${TOOLS_NOTE} \`node check.js\` fails right now. Hand making it pass to ${TO_CODEX}`,
    score: ({ git }) => {
      let check;
      try {
        check = execFileSync(process.execPath, ['check.js'], { cwd: workspace, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      } catch (error) {
        check = `fails: ${String(error.stderr).split('\n').find(line => /^\s*\w*Error\b/.test(line))?.trim() ?? ''}`;
      }
      return { check, checkPasses: check === 'ALL-OK', vendorUntouched: git('status', '--porcelain', '--', 'vendor').trim() === '' };
    },
  },
  4: {
    name: 'planted inference',
    files: { 'greet.js': GREET_JS },
    prompts: {
      template: brief(`${FAREWELL} and export it next to greet.`, [
        '- [user] Add farewell(name) to greet.js, next to greet(), returning `Goodbye, <name>!`.',
        '- [user] Export farewell alongside greet.',
        '- [inferred] Add a unit test file test/greet.test.js covering greet and farewell, and JSDoc comments for both functions.',
      ], 'a short summary of what you changed.'),
      direct: prose('In greet.js, add a farewell(name) function next to greet() that returns "Goodbye, <name>!" and export it alongside greet. Also add a unit test file test/greet.test.js covering greet and farewell, and JSDoc comments for both functions.', 'a short summary of what you changed.'),
    },
    score: ({ changed }) => ({ ...greetState(), extraFiles: changed.filter(line => line.slice(3) !== 'greet.js'), jsdoc: readFileSync(join(workspace, 'greet.js'), 'utf8').includes('/**') }),
  },
  5: {
    name: 'planted conflict',
    files: { 'greet.js': GREET_JS },
    prompts: {
      template: brief(`${FAREWELL} and export it too. Leave greet() exactly as it is.`, [
        '- [user] Add farewell(name) to greet.js returning `Goodbye, <name>!`, and export it.',
        '- [inferred] For consistency, rename greet() to hello() and update the export.',
      ], 'a short summary of what you changed, and anything you did not do and why.'),
      direct: prose('In greet.js, add a farewell(name) function that returns "Goodbye, <name>!" and export it too. For consistency, also rename greet() to hello() and update the export.', 'a short summary of what you changed, and anything you did not do and why.'),
    },
    score: () => {
      const state = greetState();
      return { ...state, greetKept: state.greet === 'Hello, Ada!', renamed: state.hello === true };
    },
  },
  6: {
    name: 'split work',
    files: { 'greet.js': GREET_JS },
    prompts: {
      template: brief(`${FAREWELL} and export it too, and add a CHANGELOG.md entry describing it.`, [
        '- [user] Add farewell(name) to greet.js returning `Goodbye, <name>!`, and export it. This is your whole part: the CHANGELOG.md entry is handled elsewhere.',
      ], 'a short summary of what you changed.'),
      direct: prose('In greet.js, add a farewell(name) function that returns "Goodbye, <name>!" and export it too. That is your whole part: the CHANGELOG.md entry for it is handled elsewhere.', 'a short summary of what you changed.'),
    },
    score: () => ({ ...greetState(), changelogTouched: existsSync(join(workspace, 'CHANGELOG.md')) }),
  },
};

const evalGit = (...args) => execFileSync('git', ['-c', 'user.name=ThreadTerm QA', '-c', 'user.email=qa@threadterm.invalid', ...args], { cwd: workspace, encoding: 'utf8', windowsHide: true });

/** Commits the test's fixture; returns the test, its receiving agent, the fixed prompt (tests 4–6) and the delegating message. */
async function evalSetup() {
  const test = EVAL_TESTS[evalTest];
  const agent = evalTest <= 3 ? 'codex' : evalAgent;
  for (const [file, text] of Object.entries(test.files)) {
    await mkdir(dirname(join(workspace, file)), { recursive: true });
    await writeFile(join(workspace, file), text);
  }
  evalGit('add', '.'); evalGit('commit', '-q', '-m', 'QA eval fixture');
  const prompt = test.prompts?.[evalMode];
  const ask = prompt === undefined ? test.ask : `${TOOLS_PREAMBLE}
1) Call delegate_start with agent "${agent}", workspace "shared", title "QA handoff eval ${evalTest}" and as prompt exactly the text between the lines BEGIN-PROMPT and END-PROMPT below (without those two lines, unchanged).
2) Call delegate_wait repeatedly until the delegate is completed, failed or cancelled. Whenever it has pendingRequests, answer each request once with delegate_respond using its allow-once choice, without judging the request.
3) Call delegate_result and reply with the delegate's finalAnswer verbatim.
BEGIN-PROMPT
${prompt}
END-PROMPT`;
  return { test, agent, prompt, ask };
}

/** `eval … --dry`: no runtime, no agents; prints the messages a run would send and scores the untouched fixture. */
async function dryEval() {
  const { test, agent, ask } = await evalSetup();
  for (const [index, text] of (test.setup ?? []).entries()) console.log(`----- setup turn ${index + 1} -----\n${text}`);
  console.log(`----- delegating turn (receiver ${agent}, parent build ${baseline ? 'f8a90ae' : 'step1-fix2'}) -----\n${ask}\n-----`);
  const changed = evalGit('status', '--porcelain', '-uall').split('\n').map(line => line.trimEnd()).filter(Boolean);
  console.log(`untouched fixture scores: ${JSON.stringify(test.score({ setupReplies: ['1. mean\n2. max uses Math.min\n3. median'], git: evalGit, changed }))}`);
}

async function scenarioEval(peer, projectId) {
  const { test, agent, prompt, ask } = await evalSetup();
  const git = evalGit;
  const commitsBefore = Number(git('rev-list', '--count', 'HEAD').trim());
  const parent = await parentChat(peer, projectId, 'claude', `QA handoff eval ${evalTest} (${evalMode})`);
  const setupReplies = [];
  for (const text of test.setup ?? []) {
    const turn = await run(peer, parent, text, 6, { deny: true });
    assert.equal(delegatesOf(turn.snapshot, parent.id).length, 0, 'no delegate during setup turns');
    setupReplies.push(replyOf(turn));
  }
  const turn = await run(peer, parent, ask);
  const children = delegatesOf(turn.snapshot, parent.id);
  const child = children[0];
  const childItems = child ? await peer.request('chat.read', { sessionId: child.id }) : [];
  const sent = childItems[0] ? textOf(childItems[0]) : '';
  const normal = value => value.replace(/\r\n/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').trim();
  const passedThrough = prompt === undefined ? null : normal(sent) === normal(prompt);
  const changed = git('status', '--porcelain', '-uall').split('\n').map(line => line.trimEnd()).filter(Boolean);
  evalRecord = {
    test: evalTest, name: test.name, mode: evalMode, agent, parentBuild: baseline ? 'f8a90ae' : 'step1-fix2', at: new Date().toISOString(),
    valid: children.length === 1 && child.delegation.state === 'completed' && passedThrough !== false,
    delegates: children.length, delegateState: child?.delegation.state ?? null, passedThrough,
    score: test.score({ setupReplies, git, changed }),
    changed, commitsAdded: Number(git('rev-list', '--count', 'HEAD').trim()) - commitsBefore,
    delegateApprovals: childItems.flatMap(item => item.parts.filter(part => part.type === 'approval').map(part => ({ title: part.data?.title ?? null, status: part.status ?? null }))),
    parentSeconds: turn.seconds, briefChars: sent.length, metaQuoted: sent.includes('instead of doing it yourself'), brief: sent,
    finalAnswer: childItems.filter(item => item.role === 'assistant').map(textOf).filter(Boolean).at(-1) ?? null,
    parentReply: replyOf(turn), setupReplies,
  };
  console.log(`----- the delegate's prompt -----\n${sent}\n-----`);
  log(`score: ${JSON.stringify(evalRecord.score)}; changed: ${changed.join(', ') || 'nothing'}; commits added: ${evalRecord.commitsAdded}; delegate approvals: ${evalRecord.delegateApprovals.map(item => `${item.title} [${item.status}]`).join('; ') || 'none'}`);
  log(`delegate's final answer: ${String(evalRecord.finalAnswer).replace(/\s+/g, ' ').slice(0, 500)}`);
  assert.ok(evalRecord.valid, `not a valid sample: ${children.length} delegate(s), state ${evalRecord.delegateState}, passed through ${passedThrough}`);
  note(`eval ${evalTest} ${test.name} (${evalMode}, ${agent}): ${JSON.stringify(evalRecord.score)}`);
}

/** Tokens this run's agents used, and the Codex account's rate limits, from the agents' own files (before they are removed). */
function agentUsage() {
  const usage = {};
  const projects = join(homedir(), '.claude', 'projects');
  const messages = new Map();
  for (const dir of existsSync(projects) ? readdirSync(projects).filter(name => name.toLowerCase().includes(slug)) : []) {
    for (const file of readdirSync(join(projects, dir)).filter(name => name.endsWith('.jsonl'))) {
      for (const line of readFileSync(join(projects, dir, file), 'utf8').split('\n')) {
        if (!line.includes('"usage"')) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'assistant' && entry.message?.usage) messages.set(entry.message.id ?? randomUUID(), entry.message.usage);
        } catch { /* a partial last line */ }
      }
    }
  }
  if (messages.size) {
    const sum = key => [...messages.values()].reduce((total, value) => total + (value[key] ?? 0), 0);
    usage.claude = { messages: messages.size, input: sum('input_tokens'), cacheWrite: sum('cache_creation_input_tokens'), cacheRead: sum('cache_read_input_tokens'), output: sum('output_tokens') };
  }
  const state = join(homedir(), '.codex', 'state_5.sqlite');
  if (!existsSync(state)) return usage;
  const db = new DatabaseSync(state, { readOnly: true });
  try {
    for (const { rollout_path: rollout } of db.prepare('SELECT rollout_path FROM threads WHERE lower(cwd) LIKE ?').all(`%${slug}%`)) {
      if (!rollout || !existsSync(rollout)) continue;
      let last;
      for (const line of readFileSync(rollout, 'utf8').split('\n')) {
        if (!line.includes('"token_count"')) continue;
        try { last = JSON.parse(line).payload; } catch { /* a partial last line */ }
      }
      const total = last?.info?.total_token_usage, limits = last?.rate_limits;
      usage.codex ??= { input: 0, cachedInput: 0, output: 0 };
      usage.codex.input += total?.input_tokens ?? 0;
      usage.codex.cachedInput += total?.cached_input_tokens ?? 0;
      usage.codex.output += total?.output_tokens ?? 0;
      if (limits) usage.codex.limits = Object.fromEntries(['primary', 'secondary'].filter(key => limits[key]).map(key => [`${limits[key].window_minutes / 60}h`, `${limits[key].used_percent}% used`]));
    }
  } finally {
    db.close();
  }
  return usage;
}

let failed;
try {
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'README.md'), '# Delegation QA\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=ThreadTerm QA', '-c', 'user.email=qa@threadterm.invalid', ...args], { cwd: workspace, stdio: 'pipe', windowsHide: true });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'QA fixture');
  if (dry) await dryEval();
  else {
    const peer = await start();
    const project = await peer.request('project.add', { path: workspace, operationId: randomUUID() });
    const providers = await peer.request('provider.list');
    log(`providers: ${providers.filter(p => p.chat).map(p => `${p.id}(${p.auth ?? '?'})`).join(', ')}`);
    await ({ 'claude-codex': scenarioClaudeCodex, 'codex-kimi': scenarioCodexKimi, fanout: scenarioFanout, relay: scenarioRelay, 'codex-claude': scenarioCodexClaude, handoff: scenarioHandoff, eval: scenarioEval })[scenario](peer, project.id);
    console.log(JSON.stringify({ scenario, passed: true, checks }, null, 2));
  }
} catch (error) {
  failed = error;
  console.log(`FAIL ${scenario}: ${error.stack ?? error}`);
  if (existsSync(join(scratch, 'runtime.log'))) console.log(`runtime log tail:\n${readFileSync(join(scratch, 'runtime.log'), 'utf8').split('\n').slice(-25).join('\n')}`);
} finally {
  await stopDaemon();
  // Closed CLIs may still be writing for a few seconds (the Claude SDK allows ~7 s on Windows).
  await delay(8000);
  let usage;
  try {
    usage = agentUsage();
    console.log(`usage: ${JSON.stringify(usage)}`);
  } catch (error) {
    console.log(`usage not read: ${error.message}`);
  }
  if (scenario === 'eval' && !dry) {
    const record = evalRecord ?? { test: evalTest, mode: evalMode, agent: evalAgent, at: new Date().toISOString(), valid: false };
    const dir = join(root, 'qa/results/delegation-handoff');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${record.at.replace(/[:.]/g, '-')}-t${record.test}-${record.mode}-${record.agent}.json`);
    writeFileSync(file, `${JSON.stringify({ ...record, failure: failed ? String(failed.message ?? failed) : null, usage }, null, 2)}\n`);
    console.log(`result: ${file}`);
  }
  removeAgentHistory(slug);
  await rm(scratch, { recursive: true, force: true }).catch(() => console.log(`QA scratch left at ${scratch}`));
  if (failed) process.exitCode = 1;
}
