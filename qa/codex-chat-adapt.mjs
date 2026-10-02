// QA: Codex Chat adaptation — slash commands, model, thinking.
// Isolated temp data/pipe. Test model: gpt-5.5-luna.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { connectPeer } from './pipe-client.mjs';

const TEST_MODEL = 'gpt-5.5-luna';
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const id = () => randomUUID();
const root = await mkdtemp(join(tmpdir(), 'threadterm-v3-codex-adapt-'));
const cwd = join(root, 'workspace');
const pipe = `\\\\.\\pipe\\threadterm-v3-codex-adapt-${id()}`;
await mkdir(cwd);
const runtimeBin = process.env.THREADTERM_V3_RUNTIME_BIN ?? resolve('runtime/target/debug/threadterm-v3-runtime.exe');
const daemon = spawn(runtimeBin, [], {
  env: {
    ...process.env,
    THREADTERM_V3_DATA: join(root, 'data'),
    THREADTERM_V3_PIPE: pipe,
  },
  windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let diagnostic = '';
daemon.stderr.on('data', (bytes) => { diagnostic += bytes.toString(); });
const report = { startedAt: new Date().toISOString(), checks: [], observations: {}, diagnosticTail: '' };
let peer;

async function connect() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const candidate = await connectPeer(`${pipe}-control`);
      const secret = (await readFile(join(root, 'data/runtime.credential'), 'utf8')).trim();
      const clientId = await candidate.auth(secret);
      return { peer: candidate, clientId };
    } catch {
      if (daemon.exitCode !== null) throw new Error(`runtime failed before connect: ${diagnostic}`);
      await delay(100);
    }
  }
  throw new Error('runtime startup timeout');
}

try {
  const connected = await connect();
  peer = connected.peer;
  const capabilities = await peer.request('provider.list');
  const codex = capabilities.find((provider) => provider.id === 'codex');
  report.observations.capability = codex;
  assert.ok(codex?.installed, 'Codex CLI is not installed');
  assert.equal(codex.auth, 'authenticated', `Codex is not authenticated: ${codex.reason ?? ''}`);
  const session = await peer.request('session.create', {
    cwd,
    title: 'Codex adapt QA',
    provider: 'codex',
    mode: 'chat',
    operationId: id(),
  }, 60_000);
  report.checks.push(`session created ${session.id}`);
  let leaseEpoch = (await peer.request('session.claim', {
    sessionId: session.id,
    clientId: connected.clientId,
  })).leaseEpoch;
  const connection = await peer.request('chat.connect', {
    sessionId: session.id,
    leaseEpoch,
    operationId: id(),
  }, 60_000);
  assert.equal(connection.phase, 'ready', `Codex did not become ready: ${JSON.stringify(connection)}`);
  report.checks.push('explicit chat.connect became ready');

  let ui = { options: [], commands: [] };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    ui = await peer.request('chat.options', { sessionId: session.id });
    if (ui.commands?.length && ui.options?.some((option) => option.id === 'model' && option.choices?.length)) break;
    await delay(250);
  }
  report.observations.ui = {
    commandNames: (ui.commands ?? []).map((command) => command.name),
    optionIds: (ui.options ?? []).map((option) => option.id),
    models: (ui.options ?? []).find((option) => option.id === 'model')?.choices?.map((choice) => choice.value) ?? [],
    thinking: (ui.options ?? []).find((option) => option.id === 'thinking'),
    mode: (ui.options ?? []).find((option) => option.id === 'mode'),
  };
  const commandNames = new Set(report.observations.ui.commandNames);
  for (const name of ['compact', 'review', 'status', 'diff', 'plan', 'model']) {
    assert.ok(commandNames.has(name), `missing slash command /${name}; have ${[...commandNames].join(',')}`);
  }
  report.checks.push(`slash commands: ${[...commandNames].slice(0, 16).join(', ')}`);
  const modelOption = (ui.options ?? []).find((option) => option.id === 'model');
  assert.ok(modelOption, 'model option missing');
  const thinkingOption = (ui.options ?? []).find((option) => option.id === 'thinking');
  assert.ok(thinkingOption, 'thinking option missing');
  const modeOption = (ui.options ?? []).find((option) => option.id === 'mode');
  assert.ok(modeOption, 'mode option missing');
  const nextEffort = (thinkingOption.choices ?? []).map((choice) => choice.value).find((value) => value && value !== thinkingOption.value);
  if (nextEffort) {
    ui = await peer.request('chat.option.set', {
      sessionId: session.id,
      optionId: 'thinking',
      value: nextEffort,
      leaseEpoch,
      operationId: id(),
    }, 30_000);
    const thinkingNow = (ui.options ?? []).find((option) => option.id === 'thinking');
    assert.equal(thinkingNow?.value, nextEffort, `thinking did not switch to ${nextEffort}, got ${thinkingNow?.value}`);
    report.checks.push(`thinking set to ${thinkingNow.value}`);
  } else {
    report.checks.push('thinking has a single choice; skipped switch');
  }

  const nextMode = (modeOption.choices ?? []).map((choice) => choice.value).find((value) => value && value !== modeOption.value) ?? 'plan';
  ui = await peer.request('chat.option.set', {
    sessionId: session.id,
    optionId: 'mode',
    value: nextMode,
    leaseEpoch,
    operationId: id(),
  }, 30_000);
  const modeNow = (ui.options ?? []).find((option) => option.id === 'mode');
  assert.equal(modeNow?.value, nextMode, `mode did not switch to ${nextMode}, got ${modeNow?.value}`);
  report.checks.push(`mode set to ${modeNow.value}`);

  const luna = (modelOption.choices ?? []).find((choice) => choice.value === TEST_MODEL || /5\.5-luna/i.test(choice.value) || /5\.5.*luna/i.test(choice.name ?? ''));
  const modelId = luna?.value ?? TEST_MODEL;
  if (luna) report.checks.push(`catalog contains ${luna.value}`);
  else report.checks.push(`catalog missing ${TEST_MODEL}; trying thread/settings/update anyway`);
  ui = await peer.request('chat.option.set', {
    sessionId: session.id,
    optionId: 'model',
    value: modelId,
    leaseEpoch,
    operationId: id(),
  }, 30_000);
  const modelAfter = (ui.options ?? []).find((option) => option.id === 'model');
  assert.equal(modelAfter?.value, modelId, `model did not switch to ${modelId}, got ${modelAfter?.value}`);
  report.checks.push(`model set to ${modelAfter.value}`);

  leaseEpoch = (await peer.request('session.renew', { sessionId: session.id, leaseEpoch })).leaseEpoch;
  await peer.request('chat.send', {
    sessionId: session.id,
    text: 'Reply with the single word OK.',
    operationId: id(),
    leaseEpoch,
  }, 30_000);
  const deadline = Date.now() + 90_000;
  let degraded = null;
  let items = [];
  let status = 'running';
  while (Date.now() < deadline) {
    const degradedEvent = peer.events.find((event) => event.event === 'runtime.degraded');
    if (degradedEvent) {
      degraded = degradedEvent.data;
      break;
    }
    const snapshot = await peer.request('runtime.snapshot');
    const row = snapshot.sessions.find((candidate) => candidate.id === session.id);
    status = row?.status ?? status;
    items = await peer.request('chat.read', { sessionId: session.id });
    const assistant = items.filter((item) => item.role === 'assistant').flatMap((item) => item.parts).some((part) => part.type === 'text' && part.text);
    if ((status === 'idle' || status === 'waiting') && assistant) break;
    if (status === 'error') break;
    await delay(400);
  }
  report.observations.send = {
    status,
    itemCount: items.length,
    roles: items.map((item) => item.role),
    degraded,
    assistantPreview: items.filter((item) => item.role === 'assistant').flatMap((item) => item.parts).find((part) => part.text)?.text?.slice(0, 160),
  };
  assert.equal(degraded, null, `chat projection degraded: ${JSON.stringify(degraded)}`);
  assert.notEqual(status, 'error', `session entered error: ${JSON.stringify(report.observations.send)}`);
  report.checks.push(`turn finished status=${status} items=${items.length}`);
  await peer.request('session.stop', { sessionId: session.id, operationId: id() });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  report.diagnosticTail = diagnostic.slice(-4000);
  report.completedAt = new Date().toISOString();
  try { await mkdir('qa/results', { recursive: true }); } catch {}
  await writeFile('qa/results/codex-chat-adapt.json', `${JSON.stringify(report, null, 2)}\n`);
  try { await peer?.request('runtime.shutdown', { operationId: id() }); } catch {}
  peer?.close();
  if (daemon.exitCode === null) {
    daemon.kill();
    await Promise.race([
      new Promise((resolveExit) => daemon.once('exit', resolveExit)),
      delay(5_000),
    ]);
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  console.log(JSON.stringify({
    passed: report.passed,
    checks: report.checks,
    observations: report.observations,
    error: report.error,
  }, null, 2));
}
