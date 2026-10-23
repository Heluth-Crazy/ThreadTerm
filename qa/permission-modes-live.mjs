// Live permission-mode durability acceptance for task 10-20-never-ask-delegation.
// Run one named scenario at a time after building runtime/target-qa/debug:
//   node qa/permission-modes-live.mjs codex
//   node qa/permission-modes-live.mjs claude
//   node qa/permission-modes-live.mjs kimi
//   node qa/permission-modes-live.mjs grok
// Each run uses a D: throwaway workspace, starts an isolated runtime, restarts it
// with surgical cleanup of only native history keyed to this scratch slug.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { connectPeer } from './pipe-client.mjs';
import { removeAgentHistory } from './agent-history.mjs';

const SCENARIOS = ['codex', 'claude', 'kimi', 'grok'];
const scenario = process.argv[2];
if (!SCENARIOS.includes(scenario)) throw Error(`usage: node qa/permission-modes-live.mjs <${SCENARIOS.join('|')}>`);
const requestedMode = process.argv.find(arg => arg.startsWith('--mode='))?.slice('--mode='.length);
const maximumOnly = process.argv.includes('--maximum-only');
const restrictiveOnly = process.argv.includes('--restrictive-only');
if (maximumOnly && !requestedMode) throw Error('--maximum-only requires an explicit --mode variant');
if (maximumOnly && restrictiveOnly) throw Error('Choose one probe scope');
if (requestedMode && !((scenario === 'kimi' && requestedMode === 'auto') || (scenario === 'grok' && ['auto', 'dontAsk'].includes(requestedMode)))) {
  throw Error('--mode=auto is available for Kimi; --mode=auto or --mode=dontAsk is available for Grok');
}
if (process.argv.includes('--dry')) {
  console.log(JSON.stringify({ scenario, mode: requestedMode ?? 'default maximum', dry: true, checks: ['maximum mode: reconnect, restart/native resume, provider-aware native write', 'restrictive mode: reconnect, restart/native resume, native write denied or carded with no artifact', 'delegate_status actual successful terminal tool card', 'Codex and Kimi parent tiny Kimi-delegate round trips'] }, null, 2));
  process.exit(0);
}

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1'));
const qaTemp = 'D:/project/ThreadTerm/tt-qa-temp';
if (!existsSync(qaTemp)) throw Error(`QA temp directory is unavailable: ${qaTemp}`);
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
if (!/runtime[\\/]target-qa[\\/]debug[\\/]threadterm-v3-runtime\.exe$/iu.test(runtime)) throw Error(`Refusing non-QA runtime: ${runtime}`);
assert.ok(existsSync(runtime), `build the QA runtime first: ${runtime}`);
assert.ok(existsSync(join(dirname(runtime), 'threadterm-v3-mcp.exe')), 'build threadterm-v3-mcp next to the QA runtime');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const scratch = await mkdtemp(join(qaTemp, 'tt-permission-modes-'));
const slug = scratch.split(/[\\/]/).at(-1).toLowerCase();
const workspace = join(scratch, 'workspace');
const data = join(scratch, 'data');
const checks = [];
const timings = [];
const turns = [];
let failureState;
const evidenceDir = join(root, '.trellis/tasks/10-20-never-ask-delegation/data');
console.log(`PROBE ${JSON.stringify({ scenario, mode: requestedMode, maximumOnly, restrictiveOnly, slug, scratch })}`);
const note = message => { checks.push(message); console.log(`PASS ${message}`); };
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(CLAUDECODE|CLAUDE_CODE_(SESSION|ENTRYPOINT|CHILD|MESSAGING|EXECPATH)|CLAUDE_PID|CLAUDE_EFFORT)$/i.test(key)));
let daemon;
let peer;
let lease = { sessionId: undefined, epoch: 0, renewed: 0 };

async function startRuntime() {
  const pipe = `\\\\.\\pipe\\tt-permission-modes-${randomUUID()}`;
  await mkdir(data, { recursive: true });
  const stderr = openSync(join(scratch, 'runtime.log'), 'a');
  daemon = spawn(runtime, [], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', stderr],
    env: { ...baseEnv, TEMP: qaTemp, TMP: qaTemp, THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(scratch, 'user'), THREADTERM_V3_PIPE: pipe, THREADTERM_CLAUDE_SDK_HOST: join(root, 'providers/claude-sdk/src/main.mjs') },
  });
  closeSync(stderr);
  console.log(`RUNTIME ${daemon.pid}`);
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      peer = await connectPeer(`${pipe}-control`);
      await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      const request = peer.request.bind(peer);
      peer.request = (method, params = {}, timeoutMs = 120_000) => request(method, params, timeoutMs);
      return;
    } catch (error) {
      peer?.close(); peer = undefined;
      if (daemon.exitCode !== null) throw Error(`QA runtime exited during startup: ${error.message}`);
      await delay(100);
    }
  }
  throw Error('QA runtime startup timeout');
}

async function stopRuntime() {
  peer?.close(); peer = undefined;
  if (daemon?.exitCode === null && daemon.signalCode === null) daemon.kill();
  if (daemon) await Promise.race([new Promise(resolve => daemon.once('exit', resolve)), delay(5_000)]);
}

async function renew(force = false) {
  if (!force && Date.now() - lease.renewed < 8_000) return;
  lease.epoch = (await peer.request('session.renew', { sessionId: lease.sessionId, leaseEpoch: lease.epoch })).leaseEpoch;
  lease.renewed = Date.now();
}

const option = async id => (await peer.request('chat.options', { sessionId: lease.sessionId })).options.find(item => item.id === id);
const valueOf = async id => (await option(id))?.value;
async function set(id, value) {
  await renew(true);
  const started = performance.now();
  let error;
  try {
    return await peer.request('chat.option.set', { sessionId: lease.sessionId, leaseEpoch: lease.epoch, optionId: id, value, operationId: randomUUID() });
  } catch (failure) { error = failure.message; throw failure; }
  finally {
    const measurement = { action: 'set', id, value, ms: Math.round(performance.now() - started), error };
    timings.push(measurement); console.log(`TIMING ${JSON.stringify(measurement)}`);
  }
}
async function expectOption(id, expected, stage) {
  assert.equal(await valueOf(id), expected, `${stage}: ${id} reports ${expected}`);
  console.log(`MODE ${JSON.stringify({ stage, id, value: expected })}`);
}

async function open(provider, title) {
  let capability;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    capability = (await peer.request('provider.list')).find(item => item.id === provider);
    if (capability) break;
    await delay(250);
  }
  assert.equal(capability?.chat, true, `${provider} Chat provider is installed and ready: ${JSON.stringify(capability)}`);
  const session = await peer.request('session.create', { cwd: workspace, provider, mode: 'chat', title, operationId: randomUUID() });
  lease.sessionId = session.id;
  lease.epoch = (await peer.request('session.claim', { sessionId: session.id, clientId: `qa-permission-modes-${scenario}` })).leaseEpoch;
  lease.renewed = Date.now();
  const state = await peer.request('chat.connect', { sessionId: session.id, leaseEpoch: lease.epoch, operationId: randomUUID() });
  assert.equal(state.phase, 'ready', `${provider} initial connect`);
  lease.nativeId = state.nativeId;
  return session;
}

async function restartAndReconnect(provider, expected) {
  const before = (await peer.request('runtime.snapshot')).sessions.find(item => item.id === lease.sessionId);
  lease.nativeId = before?.nativeId ?? lease.nativeId;
  assert.ok(lease.nativeId, `${provider} has a durable native session before restart`);
  await stopRuntime();
  await startRuntime();
  lease.epoch = (await peer.request('session.claim', { sessionId: lease.sessionId, clientId: `qa-permission-modes-${scenario}` })).leaseEpoch;
  lease.renewed = Date.now();
  const started = performance.now();
  const state = await peer.request('chat.connect', { sessionId: lease.sessionId, leaseEpoch: lease.epoch, operationId: randomUUID() });
  timings.push({ action: 'restore-connect', provider, expected, ms: Math.round(performance.now() - started) });
  console.log(`TIMING ${JSON.stringify(timings.at(-1))}`);
  assert.equal(state.phase, 'ready', `${provider} reconnect after runtime restart`);
  assert.equal(state.nativeId, lease.nativeId, `${provider} native session resumed after runtime restart`);
  for (const [id, expectedValue] of Object.entries(expected)) await expectOption(id, expectedValue, `${provider} native resume`);
  note(`${provider} restored ${Object.entries(expected).map(([id, value]) => `${id}=${value}`).join(', ')} after restart and native resume`);
}

async function reconnect(provider, expected) {
  await renew(true);
  const state = await peer.request('chat.connect', { sessionId: lease.sessionId, leaseEpoch: lease.epoch, operationId: randomUUID() });
  assert.equal(state.phase, 'ready', `${provider} reconnect`);
  if (lease.nativeId && state.nativeId) assert.equal(state.nativeId, lease.nativeId, `${provider} reconnect retains native session`);
  for (const [id, expectedValue] of Object.entries(expected)) await expectOption(id, expectedValue, `${provider} reconnect`);
  note(`${provider} retained ${Object.entries(expected).map(([id, value]) => `${id}=${value}`).join(', ')} across reconnect`);
}

const textOf = item => item.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('');
const toolParts = items => items.flatMap(item => item.parts.filter(part => part.type === 'tool'));
const errorsOf = items => items.flatMap(item => item.parts.filter(part => part.type === 'error').map(part => String(part.text ?? part.data?.message ?? 'provider error')));
function assertSuccessfulTool(items, name) {
  const calls = toolParts(items).filter(part => new RegExp(name, 'i').test(`${part.toolName ?? ''} ${part.data?.tool ?? ''} ${part.data?.rawOutput?.server_name === 'threadterm' ? part.data.rawOutput.tool_name : ''}`));
  assert.ok(calls.length, `${name} produced an actual tool card`);
  assert.ok(calls.some(part => /^(complete|completed|succeeded|success)$/i.test(String(part.status ?? '')) && !part.error && !part.data?.error && !part.data?.result?.isError), `${name} completed successfully without error data`);
}
async function oneTurn(text, { expectDelegate = false, denyPending = false, allowFailure = false, timeoutMs = 120_000 } = {}) {
  await renew(true);
  const before = (await peer.request('chat.read', { sessionId: lease.sessionId })).length;
  const { turnId } = await peer.request('chat.send', { sessionId: lease.sessionId, text, leaseEpoch: lease.epoch, operationId: randomUUID() });
  const deadline = Date.now() + timeoutMs;
  const answered = new Set();
  for (;;) {
    if (Date.now() > deadline) throw Error('model turn timed out');
    await renew();
    const snapshot = await peer.request('runtime.snapshot');
    const row = snapshot.sessions.find(item => item.id === lease.sessionId);
    const items = await peer.request('chat.read', { sessionId: lease.sessionId });
    const pending = items.flatMap(item => item.parts.filter(part => part.type === 'approval' && part.status === 'pending').map(part => ({ item, part })));
    if (pending.length && !denyPending) throw Error(`unexpected approval card: ${pending.map(card => card.part.data?.title ?? 'unnamed').join(', ')}`);
    if (denyPending) for (const { item, part } of pending) {
      if (answered.has(part.approvalId)) continue;
      answered.add(part.approvalId);
      if (part.data?.interaction === 'plan' || part.data?.interaction === 'question') {
        await peer.request('chat.answer', { sessionId: lease.sessionId, turnId: item.turnId, approvalId: part.approvalId, response: { action: part.data.interaction === 'plan' ? 'abandon' : 'dismiss' }, leaseEpoch: lease.epoch, operationId: randomUUID() });
        continue;
      }
      const choice = (part.data?.choices ?? []).find(candidate => candidate.kind === 'deny') ?? (part.data?.choices ?? []).find(candidate => /deny|reject/i.test(`${candidate.name} ${candidate.choiceId}`));
      assert.ok(choice, `restrictive native approval has a deny choice (${part.data?.title ?? 'unnamed'})`);
      await peer.request('chat.approve', { sessionId: lease.sessionId, turnId: item.turnId, approvalId: part.approvalId, choiceId: choice.choiceId, leaseEpoch: lease.epoch, operationId: randomUUID() });
    }
    const ended = row?.activity?.turnId === turnId && ['idle', 'awaiting_input'].includes(row.activity.state);
    if (ended && pending.length === 0) {
      const result = items.slice(before);
      if (!allowFailure) {
        assert.equal(errorsOf(result).length, 0, `turn has no surfaced provider errors: ${errorsOf(result).join(' | ')}`);
        assert.doesNotMatch(JSON.stringify(result), /requires approval, but approval policy is never|denied because .*don't ask/i, 'managed ThreadTerm call was not silently denied');
      }
      if (expectDelegate) {
        const delegates = snapshot.sessions.filter(item => item.delegation?.parentSessionId === lease.sessionId);
        assert.equal(delegates.length, 1, 'exactly one tiny delegate was created');
        assert.equal(delegates[0].delegation.state, 'completed', `tiny delegate completed (${delegates[0].delegation.state})`);
        assert.match(result.filter(item => item.role === 'assistant').map(textOf).join('\n'), /PERMISSION-DELEGATE-OK/);
      }
      const usage = result.flatMap(item => item.turnUsage ? [item.turnUsage] : []);
      const usageCards = result.flatMap(item => item.parts.filter(part => part.type === 'usage').map(part => part.data));
      const context = await peer.request('chat.context.read', { sessionId: lease.sessionId }).catch(() => null);
      const measured = { turnId, usage, usageCards, context, approvalsAnswered: answered.size };
      turns.push(measured); console.log(`USAGE ${JSON.stringify(measured)}`);
      return { items: result, approvalsAnswered: answered.size };
    }
    await delay(1_250);
  }
}

const STATUS = 'Call delegate_status once. Reply with exactly PERMISSION-STATUS-OK. Do not use any other tool.';
const ROUND_TRIP = `Call delegate_status once, then call delegate_start with agent "kimi", workspace "shared", title "permission mode tiny delegate", and prompt "Reply with exactly PERMISSION-DELEGATE-OK. Do not use tools." Call delegate_wait until it completes, then delegate_result. Reply with exactly the delegate final answer.`;
const nativeWrite = (name, marker) => `Use one of your native file-writing or shell tools (not a ThreadTerm MCP tool) to create ${name} in the current workspace containing exactly ${marker}. Do not only describe the action; perform it, then reply exactly NATIVE-WRITE-DONE.`;

async function withMode(provider, maximum, restrictive, configure = async () => {}, { maximumMayDenyNative = false } = {}) {
  await open(provider, `QA permission modes (${provider})`);
  await configure();
  if (!restrictiveOnly) {
  for (const [id, value] of Object.entries(maximum)) { await set(id, value); await expectOption(id, value, `${provider} maximum selection`); }
  note(`${provider} reports requested maximum mode before restart`);
  if (!lease.nativeId) {
    await configure();
    await oneTurn('Reply with exactly PERMISSION-RESUME-SEED. Do not use tools.');
    lease.nativeId = (await peer.request('runtime.snapshot')).sessions.find(item => item.id === lease.sessionId)?.nativeId;
    assert.ok(lease.nativeId, `${provider} persisted native history for the resume check`);
  }
  await reconnect(provider, maximum);
  await restartAndReconnect(provider, maximum);
  await configure();
  const maxFile = `${provider}-maximum.txt`, maxMarker = `MAX-${provider.toUpperCase()}`;
  const maxWrite = await oneTurn(nativeWrite(maxFile, maxMarker), { allowFailure: maximumMayDenyNative });
  if (maximumMayDenyNative && !existsSync(join(workspace, maxFile))) {
    assert.ok(errorsOf(maxWrite.items).length || /cannot|unable|refus|denied/i.test(maxWrite.items.filter(item => item.role === 'assistant').map(textOf).join('\n')), `${provider} maximum native denial is explicit`);
    note(`${provider} ${JSON.stringify(maximum)} explicitly denied the native write without an approval card`);
  } else {
    assert.equal((await readFile(join(workspace, maxFile), 'utf8')).trim(), maxMarker, `${provider} maximum mode completed a native write`);
    note(`${provider} ${JSON.stringify(maximum)} created the exact native-write artifact`);
  }
  assert.equal(maxWrite.approvalsAnswered, 0, `${provider} maximum mode showed no native approval card`);
  await configure();
  const statusPrompt = provider === 'grok'
    ? 'Call the ThreadTerm MCP tool threadterm__delegate_status once using use_tool with its fully qualified name and empty arguments. Reply exactly PERMISSION-STATUS-OK. Do not use other tools.'
    : STATUS;
  const status = await oneTurn(statusPrompt);
  assertSuccessfulTool(status.items, 'delegate_status');
  assert.match(status.items.filter(item => item.role === 'assistant').map(textOf).join('\n'), /PERMISSION-STATUS-OK/);
  if (!maximumOnly && (provider === 'codex' || provider === 'kimi')) {
    await configure();
    const result = await oneTurn(ROUND_TRIP, { expectDelegate: true });
    assertSuccessfulTool(result.items, 'delegate_status');
    assert.match(result.items.filter(item => item.role === 'assistant').map(textOf).join('\n'), /PERMISSION-DELEGATE-OK/);
  }
  note(`${provider} maximum mode completed a provider-appropriate native-write outcome and managed tool call${!maximumOnly && (provider === 'codex' || provider === 'kimi') ? ' plus tiny Kimi delegate round trip' : ''}`);
  if (maximumOnly) return;
  }
  for (const [id, value] of Object.entries(restrictive)) { await set(id, value); await expectOption(id, value, `${provider} restrictive selection`); }
  await reconnect(provider, restrictive);
  await restartAndReconnect(provider, restrictive);
  await configure();
  const restrictedFile = `${provider}-restrictive.txt`;
  const restrictiveWrite = await oneTurn(nativeWrite(restrictedFile, `RESTRICTED-${provider.toUpperCase()}`), { denyPending: true, allowFailure: true, timeoutMs: 90_000 });
  assert.equal(existsSync(join(workspace, restrictedFile)), false, `${provider} restrictive mode left no native-write artifact`);
  assert.ok(restrictiveWrite.approvalsAnswered || errorsOf(restrictiveWrite.items).length || /cannot|unable|refus|denied|plan/i.test(restrictiveWrite.items.filter(item => item.role === 'assistant').map(textOf).join('\n')), `${provider} restrictive write produced a denial, approval card, or explicit refusal`);
  note(`${provider} restrictive write left no artifact (${restrictiveWrite.approvalsAnswered} card(s) denied)`);
  await configure();
  const restrictiveTurn = await oneTurn(provider === 'grok'
    ? 'Call the ThreadTerm MCP tool threadterm__delegate_status once using use_tool with its fully qualified name and empty arguments. Reply exactly PERMISSION-STATUS-OK. Do not use other tools.'
    : STATUS);
  assertSuccessfulTool(restrictiveTurn.items, 'delegate_status');
  assert.match(restrictiveTurn.items.filter(item => item.role === 'assistant').map(textOf).join('\n'), /PERMISSION-STATUS-OK/);
  note(`${provider} restrictive mode survived restart, denied or carded a native write, and still exposes delegate_status`);
}

async function runScenario() {
  if (scenario === 'codex') return withMode('codex', { mode: 'never', sandbox: 'danger-full-access' }, { mode: 'on-request', sandbox: 'read-only' }, async () => {
    const luna = (await option('model'))?.choices?.find(choice => choice.value === 'gpt-6-luna' || choice.name === 'gpt-6-luna');
    assert.ok(luna, 'Codex gpt-6-luna is available for the live QA budget');
    await set('model', luna.value ?? luna.name);
  });
  if (scenario === 'claude') return withMode('claude', { mode: 'dontAsk' }, { mode: 'plan' }, async () => {
    const haiku = (await option('model'))?.choices?.find(choice => /haiku/i.test(`${choice.name} ${choice.value}`));
    assert.ok(haiku, 'Claude Haiku is available for the live QA budget');
    await set('model', haiku.value ?? haiku.name);
  }, { maximumMayDenyNative: true });
  if (scenario === 'kimi') return withMode('kimi', { mode: requestedMode ?? 'yolo' }, { mode: 'plan' });
  const grokMaximum = requestedMode ?? 'bypassPermissions';
  return withMode('grok', { mode: grokMaximum }, { mode: 'plan' }, async () => {}, { maximumMayDenyNative: grokMaximum === 'dontAsk' });
}

let failure;
try {
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'README.md'), '# Permission mode QA\n');
  await startRuntime();
  await runScenario();
  console.log(JSON.stringify({ scenario, passed: true, checks, scratch }, null, 2));
} catch (error) {
  failure = error;
  if (peer && lease.sessionId) {
    failureState = {};
    for (const method of ['chat.connection', 'chat.options', 'chat.read']) {
      try { failureState[method] = await peer.request(method, { sessionId: lease.sessionId }); } catch (readError) { failureState[method] = { error: readError.message }; }
    }
  }
  console.log(`FAIL ${scenario}: ${error.stack ?? error}`);
  if (existsSync(join(scratch, 'runtime.log'))) console.log(`runtime log tail:\n${(await readFile(join(scratch, 'runtime.log'), 'utf8')).split(/\r?\n/).slice(-30).join('\n')}`);
} finally {
  await stopRuntime();
  await delay(8_000);
  const leftovers = removeAgentHistory(slug);
  if (leftovers.length && !failure) failure = Error(`Probe history cleanup left ${leftovers.join(' | ')}`);
  await mkdir(evidenceDir, { recursive: true });
  const evidence = { scenario, mode: requestedMode, maximumOnly, restrictiveOnly, slug, passed: !failure, error: failure?.stack, checks, timings, turns, failureState, leftovers };
  await writeFile(join(evidenceDir, `${slug}.json`), JSON.stringify(evidence, null, 2));
  if (existsSync(join(scratch, 'runtime.log'))) await writeFile(join(evidenceDir, `${slug}.runtime.log`), await readFile(join(scratch, 'runtime.log')));
  await rm(scratch, { recursive: true, force: true }).catch(() => console.log(`QA scratch left at ${scratch}`));
  if (failure) process.exitCode = 1;
}
