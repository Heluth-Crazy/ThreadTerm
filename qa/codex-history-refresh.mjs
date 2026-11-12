// Run against a debug runtime with a fake Codex app-server and private data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { connectPeer } from './pipe-client.mjs';

const args = process.argv.slice(2);
const runtimeIndex = args.indexOf('--runtime');
assert.ok(runtimeIndex !== -1 && args[runtimeIndex + 1], 'Pass --runtime <debug runtime path>');
assert.equal(process.platform, 'win32', 'This probe uses Windows command shims and named pipes');
const runtime = resolve(args[runtimeIndex + 1]);
const baseline = args.includes('--baseline');
const nativeId = 'qa-history-refresh-thread';
const scratch = await mkdtemp(join(tmpdir(), 'tt-history-refresh-'));
const cwd = join(scratch, 'workspace');
const bin = join(scratch, 'bin');
const data = join(scratch, 'data');
const codexHome = join(scratch, 'codex');
const tmp = join(scratch, 'temp');
const historyFile = join(scratch, 'history.json');
const log = join(scratch, 'native.jsonl');
const pipe = '\\\\.\\pipe\\tt-history-refresh-' + randomUUID();
const fixture = fileURLToPath(new URL('./fixtures/fake-codex-history-refresh.cjs', import.meta.url));
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT|ProgramData)$/i.test(key)));
const env = {
  ...inherited, HOME: scratch, USERPROFILE: scratch, HOMEDRIVE: scratch.slice(0, 2), HOMEPATH: scratch.slice(2),
  APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'local'),
  TEMP: tmp, TMP: tmp, CODEX_HOME: codexHome, THREADTERM_QA_PROVIDER_BIN: bin,
  THREADTERM_V3_DATA: data, THREADTERM_V3_PIPE: pipe,
  TT_QA_HISTORY_FILE: historyFile, TT_QA_HISTORY_CWD: cwd, TT_QA_HISTORY_LOG: log,
};
const message = item => item.parts.filter(part => part.type === 'text').map(part => part.text).join('');
const messages = items => items.filter(item => ['user', 'assistant'].includes(item.role) && message(item));
const texts = items => messages(items).map(message);

function externalTurn(id, prompt, reply, status = 'completed') {
  return { id, status, items: [
    { id: id + '-user', type: 'userMessage', content: [{ type: 'text', text: prompt, text_elements: [] }] },
    { id: id + '-tool', type: 'commandExecution', command: 'echo external tool', status: 'completed' },
    { id: id + '-plan', type: 'plan', text: 'external plan must stay out of Chat' },
    { id: id + '-answer', type: 'agentMessage', phase: 'final_answer', text: reply },
  ] };
}

async function until(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}

let child;
let peer;
let diagnostics = '';
try {
  await Promise.all([cwd, bin, data, codexHome, tmp, env.APPDATA, env.LOCALAPPDATA].map(path => mkdir(path)));
  await writeFile(join(bin, 'codex.cmd'), '@"' + process.execPath + '" "' + fixture + '" %*\r\n');
  const seed = externalTurn('imported-at-create', 'original imported prompt', 'original imported reply');
  // Keep the historical seed to user/assistant text. Later turns exercise
  // filtering external plan and tool items.
  seed.items = seed.items.filter(item => ['userMessage', 'agentMessage'].includes(item.type));
  await writeFile(historyFile, JSON.stringify([seed]));
  child = spawn(runtime, [], { cwd, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-4000); });
  let clientId;
  await until(async () => {
    try {
      peer = await connectPeer(pipe + '-control');
      clientId = await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      return true;
    } catch (error) {
      peer?.close();
      peer = undefined;
      if (child.exitCode !== null) throw error;
      return false;
    }
  }, 'isolated runtime ready');

  const session = await peer.request('session.create', {
    provider: 'codex', mode: 'chat', cwd, nativeId, operationId: randomUUID(),
  });
  const sessionId = session.id;
  const { leaseEpoch } = await peer.request('session.claim', { sessionId, clientId });
  const mutation = (method, params = {}) => peer.request(method, {
    sessionId, leaseEpoch, operationId: randomUUID(), ...params,
  });
  const present = () => peer.request('session.present', {
    sessionId, placement: 'workspace', presentation: 'focused', workspacePath: cwd, operationId: randomUUID(),
  });
  const snapshot = params => peer.request('chat.snapshot', { sessionId, ...params });
  const waitForText = text => until(async () => {
    const { items } = await snapshot();
    const status = (await peer.request('runtime.snapshot')).sessions.find(row => row.id === sessionId)?.status;
    return status === 'idle' && texts(items).includes(text);
  }, 'settled text: ' + text);
  await mutation('chat.connect');
  for (const prompt of ['first local prompt', 'second local prompt']) {
    await mutation('chat.send', { text: prompt });
    await waitForText('local answer for ' + prompt);
  }
  const before = await snapshot();
  const originalMessages = messages(before.items);
  assert.deepEqual(texts(before.items), [
    'original imported prompt', 'original imported reply',
    'first local prompt', 'local answer for first local prompt',
    'second local prompt', 'local answer for second local prompt',
  ]);
  const [imported, first, second] = JSON.parse(await readFile(historyFile, 'utf8'));
  const sameText = ['repeat external prompt', 'repeat external reply'];
  const between = externalTurn('external-between', ...sameText);
  const latest = externalTurn('external-latest', ...sameText);
  const unfinished = externalTurn('external-open', 'unfinished prompt', 'unfinished reply', 'inProgress');
  await writeFile(historyFile, JSON.stringify([imported, first, between, second, latest, unfinished]));
  const native = await peer.request('history.read', { provider: 'codex', nativeId });
  assert.equal(texts(native).filter(text => text === sameText[1]).length, 2, 'the native reader sees both external turns');

  await present();
  const refreshOperation = randomUUID();
  const connection = () => peer.request('chat.connection', { sessionId });
  if (!baseline) {
    const warm = await connection();
    assert.equal(warm.phase, 'ready');
    await writeFile(historyFile + '.fail-read', '');
    await assert.rejects(mutation('chat.refreshHistory'), /QA history read unavailable/);
    await rm(historyFile + '.fail-read');
    assert.deepEqual(messages((await snapshot()).items), originalMessages);
    await writeFile(historyFile + '.fail-resume', '');
    assert.deepEqual(await mutation('chat.refreshHistory', { operationId: refreshOperation }), { added: 4 });
    const refreshed = await connection();
    assert.equal(refreshed.phase, 'ready');
    assert.equal(refreshed.connectionGeneration, warm.connectionGeneration,
      'history refresh keeps the existing worker when a replacement would fail');
  }
  const after = await snapshot();
  const expected = [
    'original imported prompt', 'original imported reply',
    'first local prompt', 'local answer for first local prompt', ...sameText,
    'second local prompt', 'local answer for second local prompt', ...sameText,
  ];
  assert.deepEqual(texts(after.items), expected, 'returning imports completed messages once and in native order');
  assert.deepEqual(messages(after.items).filter(item => originalMessages.some(original => original.id === item.id)),
    originalMessages, 'all original message records survive byte-for-byte');
  assert.ok(!after.items.some(item => item.parts.some(part => part.toolName === 'commandExecution')),
    'external tool activity stays out of Chat');

  const paged = [];
  let beforeCursor;
  do {
    const page = await snapshot({ before: beforeCursor, maxBytes: 1024 });
    paged.unshift(...page.items);
    beforeCursor = page.nextBefore;
  } while (beforeCursor);
  assert.deepEqual(texts(paged), expected, 'paginated Chat uses the same merged order');

  await present();
  assert.deepEqual(await mutation('chat.refreshHistory', { operationId: refreshOperation }), { added: 4 }, 'refresh receipt is replay-safe');
  assert.deepEqual(await mutation('chat.refreshHistory'), { added: 0 });
  assert.deepEqual(messages((await snapshot()).items), messages(after.items), 'repeated return is a no-op');
  const send = { text: 'use external context', operationId: randomUUID() };
  await assert.rejects(mutation('chat.send', send), /QA native reopen unavailable/);
  assert.deepEqual(texts((await snapshot()).items), expected, 'failed reopen records no user prompt');
  await rm(historyFile + '.fail-resume');
  await mutation('chat.send', send);
  await waitForText('saw latest external turn');
  const nativeRequests = (await readFile(log, 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  const nextSend = nativeRequests.find(row => row.method === 'turn/start' && row.text === 'use external context');
  assert.ok(nextSend?.seesExternal && nextSend.threadId === nativeId, 'the next send uses refreshed context in the same thread');

  await mutation('chat.send', { text: 'slow local prompt' });
  await until(async () => (await peer.request('runtime.snapshot')).sessions
    .find(row => row.id === sessionId)?.status === 'running', 'slow local turn is active');
  assert.deepEqual(await mutation('chat.refreshHistory'), { added: 0 }, 'refresh does not retire an active worker');
  await writeFile(historyFile + '.complete-slow', '');
  await waitForText('local answer for slow local prompt');
  console.log('PASS: exact identities, native order, pagination, deduplication, next-send context and active-worker protection');
} catch (error) {
  if (diagnostics) console.error(diagnostics);
  throw error;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    if (peer) await peer.request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
    const settled = await Promise.race([exited.then(() => true), delay(4_000, false)]);
    if (!settled) {
      child.kill();
      await exited;
    }
  }
  peer?.close();
  await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
