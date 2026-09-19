import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { connectPeer } from './pipe-client.mjs';

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const id = () => randomUUID();
const root = await mkdtemp(join(tmpdir(), 'threadterm-v3-grok-chat-'));
const cwd = join(root, 'workspace');
const pipe = `\\\\.\\pipe\\threadterm-v3-grok-chat-${id()}`;
await mkdir(cwd);
const runtimeBin = process.env.THREADTERM_V3_RUNTIME_BIN
  || (existsSync(resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe'))
    ? resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe')
    : resolve('runtime/target/debug/threadterm-v3-runtime.exe'));
const daemon = spawn(runtimeBin, [], {
  env: { ...process.env, THREADTERM_V3_DATA: join(root, 'data'), THREADTERM_V3_PIPE: pipe },
  windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let diagnostic = '';
daemon.stderr.on('data', (bytes) => { diagnostic += bytes.toString(); });
const report = { startedAt: new Date().toISOString(), checks: [], observations: {} };
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
  if (process.env.THREADTERM_QA_GROK_PROXY) {
    const snapshot = await peer.request('runtime.snapshot', {}, 60_000);
    await peer.request('settings.update', {
      patch: { providerNetwork: { grok: {
        mode: 'custom', proxyUrl: process.env.THREADTERM_QA_GROK_PROXY,
        noProxy: 'localhost,127.0.0.1,::1',
      } } },
      expectedRevision: snapshot.settings.revision,
      operationId: id(),
    });
    report.checks.push('saved custom Grok proxy through settings.update');
  }
  const capabilities = await peer.request('provider.list');
  const grok = capabilities.find((provider) => provider.id === 'grok');
  report.observations.capability = grok;
  assert.ok(grok?.installed, `Grok not installed: ${JSON.stringify(grok)}`);
  assert.equal(grok.chat, true, `Grok chat not advertised: ${JSON.stringify(grok)}`);
  const session = await peer.request('session.create', {
    cwd,
    title: 'Grok chat smoke',
    provider: 'grok',
    mode: 'chat',
    operationId: id(),
  }, 60_000);
  report.checks.push(`session ${session.id}`);
  const leaseEpoch = (await peer.request('session.claim', {
    sessionId: session.id,
    clientId: connected.clientId,
  })).leaseEpoch;
  const connection = await peer.request('chat.connect', {
    sessionId: session.id,
    leaseEpoch,
    operationId: id(),
  }, 60_000);
  assert.equal(connection.phase, 'ready', `Grok did not become ready: ${JSON.stringify(connection)}`);
  report.checks.push('explicit chat.connect became ready');
  let ui = { options: [], commands: [] };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    ui = await peer.request('chat.options', { sessionId: session.id });
    if (ui.options?.some((option) => option.id === 'model')) break;
    await delay(250);
  }
  report.observations.ui = {
    optionIds: (ui.options ?? []).map((option) => option.id),
    commandNames: (ui.commands ?? []).map((command) => command.name).slice(0, 12),
    model: (ui.options ?? []).find((option) => option.id === 'model')?.value,
    thinking: (ui.options ?? []).find((option) => option.id === 'thinking')?.value,
    mode: (ui.options ?? []).find((option) => option.id === 'mode')?.value,
  };
  if (process.env.THREADTERM_QA_GROK_COMMANDS === '1') {
    const emptyTurn = await peer.request('chat.send', {
      sessionId: session.id, text: '/usage', operationId: id(), leaseEpoch,
    });
    let emptyParts = [];
    for (let attempt = 0; attempt < 350; attempt += 1) {
      emptyParts = (await peer.request('chat.read', { sessionId: session.id }))
        .filter(item => item.role === 'assistant' && item.turnId === emptyTurn.turnId).flatMap(item => item.parts);
      const state = await peer.request('runtime.snapshot');
      if (emptyParts.length && state.sessions.find(row => row.id === session.id)?.status === 'idle') break;
      await delay(100);
    }
    assert.ok(emptyParts.some(part => part.text?.includes('No model calls yet in this session')), 'fresh usage must match CLI no-calls state');
    assert.ok(emptyParts.some(part => part.data?.kind === 'plan' && Number.isFinite(part.data.rows?.[0]?.percent)), 'fresh usage must include genuine account allowance');
    report.observations.emptyUsageParts = emptyParts;
    report.checks.push('fresh /usage shows native account allowance and no-model-calls state');
  }
  const sent = await peer.request('chat.send', {
    sessionId: session.id,
    text: 'Reply with the single word OK.',
    operationId: id(),
    leaseEpoch,
  }, 30_000);
  report.checks.push(`sent turn ${sent.turnId}`);
  const deadline = Date.now() + 90_000;
  let items = [];
  let snapshot;
  while (Date.now() < deadline) {
    const degraded = peer.events.find((event) => event.event === 'runtime.degraded');
    if (degraded) {
      report.observations.degraded = degraded.data;
      break;
    }
    items = await peer.request('chat.read', { sessionId: session.id });
    snapshot = await peer.request('runtime.snapshot');
    const assistantText = items
      .filter((item) => item.role === 'assistant' && item.turnId === sent.turnId)
      .flatMap((item) => item.parts)
      .filter((part) => part.type === 'text' && part.text)
      .map((part) => part.text)
      .join('');
    const thinking = items.some((item) => item.parts.some((part) => part.type === 'thinking' && part.text));
    const error = items.some((item) => item.parts.some((part) => part.type === 'error'));
    report.observations.progress = {
      status: snapshot.sessions.find((row) => row.id === session.id)?.status,
      itemCount: items.length,
      roles: items.map((item) => item.role),
      partTypes: items.flatMap((item) => item.parts.map((part) => part.type)),
      assistantText: assistantText.slice(0, 200),
      thinking,
      error,
    };
    if (assistantText || error) break;
    await delay(400);
  }
  report.observations.items = items.map((item) => ({
    role: item.role,
    elapsedMs: item.elapsedMs,
    parts: item.parts.map((part) => ({ type: part.type, status: part.status, text: (part.text ?? '').slice(0, 80) })),
  }));
  report.observations.events = peer.events.slice(-12).map((event) => ({ event: event.event, kind: event.data?.kind, sessionId: event.data?.sessionId }));
  const assistantText = items
    .filter((item) => item.role === 'assistant' && item.turnId === sent.turnId)
    .flatMap((item) => item.parts)
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('');
  assert.ok(assistantText, `no assistant text: ${JSON.stringify(report.observations)}`);
  if (process.env.THREADTERM_QA_GROK_COMMANDS === '1') {
    // Wait for the native turn completion, not only the first streamed text.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      snapshot = await peer.request('runtime.snapshot');
      if (snapshot.sessions.find((row) => row.id === session.id)?.status === 'idle') break;
      await delay(100);
    }
    assert.equal(snapshot.sessions.find((row) => row.id === session.id)?.status, 'idle');
    report.observations.commands = {};
    report.observations.commandParts = {};
    const commands = [['/usage', 'Grok session usage'], ['/status', 'Grok session status'], ['/help', 'Grok Chat commands']];
    if (process.env.THREADTERM_QA_GROK_COMPACT === '1') commands.push(['/compact', 'Grok completed conversation compaction.']);
    for (const [command, expected] of commands) {
      const before = (await peer.request('chat.read', { sessionId: session.id })).length;
      await peer.request('chat.send', { sessionId: session.id, text: command, operationId: id(), leaseEpoch }, 60_000);
      let result = [];
      for (let attempt = 0; attempt < 900; attempt += 1) {
        result = (await peer.request('chat.read', { sessionId: session.id })).slice(before).filter(item => item.role === 'assistant');
        if (result.some(item => item.parts.some(part => part.text?.includes(expected)))) break;
        await delay(100);
      }
      const text = result.flatMap(item => item.parts).map(part => part.text || '').join('\n');
      assert.ok(text.includes(expected), `${command} missing local native result: ${text}`);
      assert.ok(!result.some(item => item.parts.some(part => ['tool', 'thinking', 'error'].includes(part.type))), `${command} unexpectedly invoked model/tools or failed`);
      report.observations.commands[command] = text;
      report.observations.commandParts[command] = result.flatMap(item => item.parts);
      if (command === '/usage') {
        const plan = result.flatMap(item => item.parts).find(part => part.data?.kind === 'plan');
        assert.ok(plan?.data.rows?.length, 'usage must contain real native account limits, not session-only statistics');
        assert.ok(plan.data.rows.every(row => Number.isFinite(row.percent) && row.resetAt), 'native account limits must include reported percentage and reset');
        assert.ok(text.includes('since start or last resume'), 'usage scope must match CLI');
      }
      report.checks.push(`${command} native/local result without model tools`);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        snapshot = await peer.request('runtime.snapshot');
        if (snapshot.sessions.find((row) => row.id === session.id)?.status === 'idle') break;
        await delay(100);
      }
      assert.equal(snapshot.sessions.find((row) => row.id === session.id)?.status, 'idle');
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      snapshot = await peer.request('runtime.snapshot');
      if (snapshot.sessions.find((row) => row.id === session.id)?.status === 'idle') break;
      await delay(100);
    }
    assert.equal(snapshot.sessions.find((row) => row.id === session.id)?.status, 'idle', 'command must complete its turn');
  }
  report.passed = true;
  report.checks.push(`assistant: ${assistantText.slice(0, 80)}`);
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  report.diagnosticTail = diagnostic.slice(-6000);
  report.completedAt = new Date().toISOString();
  try { await mkdir('qa/results', { recursive: true }); } catch {}
  await writeFile('qa/results/grok-chat-smoke.json', `${JSON.stringify(report, null, 2)}\n`);
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
    diagnosticTail: report.diagnosticTail?.slice(-2000),
  }, null, 2));
}
