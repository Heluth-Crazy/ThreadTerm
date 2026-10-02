// Live Claude Chat check for task 09-29-agent-compat-claude: the target-qa runtime with
// isolated ThreadTerm data, the bundled Claude CLI and the caller's normal Claude
// configuration (whatever `claude auth status` reports). About six short model turns.
//   node qa/claude-chat-live.mjs
// Never sends commands that open a browser. The temporary workspace and its Claude
// history folder under ~/.claude/projects are removed afterwards.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
const scratch = await mkdtemp(join(tmpdir(), 'tt-claude-live-'));
const workspace = join(scratch, 'workspace');
const checks = [];
const note = text => { checks.push(text); console.log(`PASS ${text}`); };
const SKILL_MARK = 'TT-SKILL-LIVE-3319';
await mkdir(join(workspace, '.claude/skills/tt-probe-skill'), { recursive: true });
await writeFile(join(workspace, '.claude/skills/tt-probe-skill/SKILL.md'),
  `---\nname: tt-probe-skill\ndescription: ThreadTerm probe skill. Use only when the user invokes /tt-probe-skill.\n---\nWhen this skill runs, reply with exactly ${SKILL_MARK} and nothing else. Do not use any tools.\n`);
await writeFile(join(workspace, 'tt.js'), 'console.log(42);\n');

// The desktop starts the runtime outside any Claude Code session.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(CLAUDECODE|CLAUDE_CODE_(SESSION|ENTRYPOINT|CHILD|MESSAGING|EXECPATH)|CLAUDE_PID|CLAUDE_EFFORT)/.test(key)));
let daemon;
const peers = new Set();

async function start(name, extraEnv = {}, dropEnv = []) {
  const data = join(scratch, `${name}-data`);
  const pipe = `\\\\.\\pipe\\tt-claude-live-${randomUUID()}`;
  await mkdir(data, { recursive: true });
  const env = { ...baseEnv, ...extraEnv, THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(scratch, `${name}-user`), THREADTERM_V3_PIPE: pipe };
  for (const key of dropEnv) delete env[key];
  daemon = spawn(exe, [], { windowsHide: true, env, stdio: 'ignore' });
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
  await delay(300);
}

const option = (ui, id) => ui.options.find(candidate => candidate.id === id);
const textOf = item => item.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('');

const lease = { epoch: 0, renewed: 0 };
async function renew(peer, session, force = false) {
  if (!force && Date.now() - lease.renewed < 10000) return;
  lease.epoch = (await peer.request('session.renew', { sessionId: session.id, leaseEpoch: lease.epoch })).leaseEpoch;
  lease.renewed = Date.now();
}

async function run(peer, session, text) {
  await renew(peer, session, true);
  const before = (await peer.request('chat.read', { sessionId: session.id })).length;
  const { turnId } = await peer.request('chat.send', { sessionId: session.id, text, leaseEpoch: lease.epoch, operationId: randomUUID() });
  const approvals = [];
  const deadline = Date.now() + 240000;
  for (;;) {
    if (Date.now() > deadline) throw Error(`turn timed out: ${text}`);
    await renew(peer, session);
    const items = await peer.request('chat.read', { sessionId: session.id });
    const status = (await peer.request('runtime.snapshot')).sessions.find(value => value.id === session.id)?.status;
    const pending = items.flatMap(item => item.parts.filter(part => part.type === 'approval' && part.status === 'pending').map(part => ({ item, part })));
    for (const card of pending) {
      if (approvals.some(seen => seen.part.approvalId === card.part.approvalId)) continue;
      approvals.push(card);
      const choice = run.onApproval?.(card.part);
      if (choice) await peer.request('chat.approve', { sessionId: session.id, turnId: card.item.turnId, approvalId: card.part.approvalId, choiceId: choice, leaseEpoch: lease.epoch, operationId: randomUUID() });
    }
    if (status === 'idle' && !pending.length) return { turnId, items: items.slice(before), approvals };
    await delay(500);
  }
}

try {
  // 1. Capability follows the Chat CLI's own auth status.
  let peer = await start('main');
  const claude = (await peer.request('provider.list')).find(value => value.id === 'claude');
  assert.equal(claude.auth, 'authenticated', `Claude auth: ${claude.auth} ${claude.reason ?? ''}`);
  assert.equal(claude.chat, true);
  note(`capability: auth=${claude.auth} chat=${claude.chat} note=${claude.reason ?? '(none)'}`);

  // 2. Options and command menu straight after connect, before any model turn.
  const session = await peer.request('session.create', { cwd: workspace, title: 'QA claude chat live', provider: 'claude', mode: 'chat', operationId: randomUUID() });
  lease.epoch = (await peer.request('session.claim', { sessionId: session.id, clientId: 'qa-claude-live' })).leaseEpoch;
  lease.renewed = Date.now();
  assert.equal((await peer.request('chat.connect', { sessionId: session.id, leaseEpoch: lease.epoch, operationId: randomUUID() })).phase, 'ready');
  let ui = await peer.request('chat.options', { sessionId: session.id });
  const names = ui.commands.map(command => command.name);
  assert.deepEqual(ui.options.map(value => value.id).filter(id => id !== 'thinking'), ['model', 'mode']);
  assert.ok(names.includes('compact') && names.includes('tt-probe-skill'), 'menu lists /compact and the project skill');
  for (const hidden of ['clear', 'extra-usage', 'usage-credits']) assert.ok(!names.includes(hidden), `/${hidden} is hidden`);
  assert.ok(!option(ui, 'mode').choices.some(choice => choice.value === 'bypassPermissions'), 'no Bypass');
  note(`options before any turn: model=${option(ui, 'model').value} thinking=${option(ui, 'thinking')?.value ?? '-'} mode=${option(ui, 'mode').value} modes=[${option(ui, 'mode').choices.map(c => c.value)}] commands=${names.length}`);

  // 3. Model switch reaches the CLI (applied state: Haiku has no effort levels).
  ui = await peer.request('chat.option.set', { sessionId: session.id, optionId: 'model', value: 'haiku', leaseEpoch: lease.epoch, operationId: randomUUID() });
  assert.equal(option(ui, 'model').value, 'haiku');
  assert.equal(option(ui, 'thinking'), undefined, 'the CLI reports no effort for Haiku');
  let turn = await run(peer, session, 'Reply with exactly MODEL-OK and nothing else. Do not use any tools.');
  const modelReply = turn.items.filter(item => item.role === 'assistant').map(textOf).join(' ');
  assert.match(modelReply, /MODEL-OK/);
  note(`model switch: next turn answered "${modelReply.slice(0, 80)}"`);

  // 4. Thinking and permission mode switches reach the CLI.
  ui = await peer.request('chat.option.set', { sessionId: session.id, optionId: 'model', value: 'default', leaseEpoch: lease.epoch, operationId: randomUUID() });
  assert.ok(option(ui, 'thinking'), 'effort levels return with the default model');
  ui = await peer.request('chat.option.set', { sessionId: session.id, optionId: 'thinking', value: 'low', leaseEpoch: lease.epoch, operationId: randomUUID() });
  ui = await peer.request('chat.option.set', { sessionId: session.id, optionId: 'mode', value: 'plan', leaseEpoch: lease.epoch, operationId: randomUUID() });
  assert.equal(option(ui, 'mode').value, 'plan');
  assert.equal(option(ui, 'thinking').value, 'low');
  await assert.rejects(peer.request('chat.option.set', { sessionId: session.id, optionId: 'mode', value: 'bypassPermissions', leaseEpoch: lease.epoch, operationId: randomUUID() }));
  ui = await peer.request('chat.option.set', { sessionId: session.id, optionId: 'mode', value: 'default', leaseEpoch: lease.epoch, operationId: randomUUID() });
  note('thinking=low and mode=plan/default applied through SDK control requests; Bypass refused');

  // 5. A project skill chosen from the menu.
  turn = await run(peer, session, '/tt-probe-skill');
  assert.match(turn.items.map(textOf).join(' '), new RegExp(SKILL_MARK));
  note('/tt-probe-skill ran the project skill');

  // 6. "Always allow" stores the SDK suggestion; the identical repeat does not ask.
  run.onApproval = part => {
    const choices = part.data?.choices ?? [];
    note(`approval choices: ${choices.map(choice => `${choice.choiceId}=${choice.label}/${choice.scope}`).join(', ')}`);
    return choices.some(choice => choice.choiceId === 'allow_always') ? 'allow_always' : 'allow';
  };
  turn = await run(peer, session, 'Use your shell tool to run exactly this command in the current directory: node tt.js  Do not read the file first. Then reply DONE.');
  assert.equal(turn.approvals.length, 1, 'one approval card');
  assert.ok(turn.approvals[0].part.data.choices.some(choice => choice.choiceId === 'allow_always'), 'Always allow offered');
  run.onApproval = () => { throw Error('the repeated command must not ask again'); };
  turn = await run(peer, session, 'Run exactly the same shell command again: node tt.js  Then reply DONE.');
  assert.equal(turn.approvals.length, 0);
  note('Always allow stopped the repeat prompt for the same command');
  run.onApproval = undefined;

  // 7. Local command output is visible; /compact compacts.
  turn = await run(peer, session, '/context');
  assert.match(turn.items.map(textOf).join('\n'), /Context Usage/);
  note('/context output is visible in Chat');
  turn = await run(peer, session, '/compact');
  assert.match(turn.items.map(textOf).join('\n'), /Compacted/);
  note('/compact compacted and reported it');

  // 8. /clear is refused before it is recorded.
  const count = (await peer.request('chat.read', { sessionId: session.id })).length;
  await assert.rejects(peer.request('chat.send', { sessionId: session.id, text: '/clear', leaseEpoch: lease.epoch, operationId: randomUUID() }), error => /\/clear/.test(error.message));
  assert.equal((await peer.request('chat.read', { sessionId: session.id })).length, count, 'no user bubble for a refused command');
  note('/clear refused with an explanation and nothing recorded');

  // 9. Without any credentials the capability says exactly what is missing.
  await stopDaemon();
  const emptyConfig = join(scratch, 'empty-claude-config');
  await mkdir(emptyConfig, { recursive: true });
  peer = await start('signed-out', { CLAUDE_CONFIG_DIR: emptyConfig }, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']);
  const signedOut = (await peer.request('provider.list')).find(value => value.id === 'claude');
  assert.equal(signedOut.auth, 'unauthenticated');
  assert.equal(signedOut.chat, false);
  assert.match(signedOut.reason, /not signed in/);
  note(`signed out: auth=${signedOut.auth} chat=${signedOut.chat} reason="${signedOut.reason.split(' / ')[0]}"`);

  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await stopDaemon();
  const projects = join(homedir(), '.claude', 'projects');
  // The closed CLI may keep writing for a few seconds (the SDK allows ~7 s on
  // Windows), and Windows can change the folder name's case.
  const slug = basename(scratch).toLowerCase();
  await new Promise(resolve => setTimeout(resolve, 8000));
  for (const dir of existsSync(projects) ? await readdir(projects) : []) {
    if (dir.toLowerCase().includes(slug)) { await rm(join(projects, dir), { recursive: true, force: true }); console.log(`removed Claude history ${dir}`); }
  }
  await rm(scratch, { recursive: true, force: true }).catch(() => console.log(`QA scratch left at ${scratch}`));
}
