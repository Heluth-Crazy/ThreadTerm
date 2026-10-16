import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the actual fake app-server in-process, including separate verifier state.
// No provider, child process, profile, or network is used.
const source = readFileSync(new URL('../qa/fixtures/browser-plugins/fake-codex-browser.cjs', import.meta.url), 'utf8');
function fixture(pid, args = ['app-server']) {
  const output = [], events = [];
  let onLine;
  const modules = {
    'node:child_process': { spawn() { throw Error('Unexpected child process'); } },
    'node:fs': { appendFileSync(_path, line) { events.push(JSON.parse(line)); } },
    'node:readline': { createInterface: () => ({ on(_event, handler) { onLine = handler; } }) },
  };
  const exited = {};
  try {
    vm.runInNewContext(source, {
      require: name => { assert.ok(name in modules, name); return modules[name]; },
      process: { pid, argv: ['node', 'fake-codex-browser.cjs', ...args], stdin: {}, env: { THREADTERM_QA_BROWSER_CWD: 'D:/qa/work', THREADTERM_QA_BROWSER_EVENTS: 'events.jsonl' }, stdout: { write: line => output.push(JSON.parse(line)) }, exit: () => { throw exited; } },
      console: { log() {} },
    });
  } catch (error) { if (error !== exited) throw error; }
  return { events, async rpc(method, params = {}) { const id = output.length + 1; await onLine(JSON.stringify({ id, method, params })); return output.find(row => row.id === id)?.result; } };
}

test('browser fixture supports persistent new-chat verification through a second app-server', async () => {
  const owner = fixture(101);
  await owner.rpc('initialize');
  assert.equal((await owner.rpc('account/read')).account.type, 'chatgpt');
  const started = await owner.rpc('thread/start', { cwd: 'D:/qa/work', threadSource: 'user' });
  const nativeId = started.thread.id;
  assert.deepEqual(await owner.rpc('thread/inject_items', { threadId: nativeId, items: [{ type: 'message', role: 'developer', content: [] }] }), {});
  const stored = (await fixture(202).rpc('thread/read', { threadId: nativeId, includeTurns: true })).thread;
  assert.equal(stored.id, nativeId);
  assert.equal(stored.cwd, 'D:/qa/work');
  assert.equal(stored.source, 'user');
  assert.equal(stored.ephemeral, false);
  assert.deepEqual(stored.turns, []);
});

test('browser fixture resumes the requested identity and preserves the root history shape', async () => {
  const server = fixture(303);
  const resumed = (await server.rpc('thread/resume', { threadId: 'prior-thread', cwd: 'D:/qa/restored' })).thread;
  assert.equal(resumed.id, 'prior-thread');
  assert.equal(resumed.cwd, 'D:/qa/restored');
  assert.deepEqual(resumed.turns, []);
  assert.equal((await server.rpc('thread/read', { threadId: 'prior-thread' })).thread.id, 'prior-thread');
});

test('browser fixture logs probes and creation methods without recording grants or prompts', async () => {
  assert.equal(fixture(404, ['--version']).events[0].name, 'cli.version');
  assert.equal(fixture(404, ['login', 'status']).events[0].name, 'cli.login-status');
  const server = fixture(404, ['-c', "mcp_servers.threadterm.env={TOKEN='secret-grant'}", 'app-server']);
  await server.rpc('thread/start', { cwd: 'D:/qa/work', secret: 'secret-prompt' });
  await server.rpc('thread/read', { threadId: 'prior-thread', includeTurns: true });
  assert.deepEqual(server.events.map(row => row.name), ['cli.app-server', 'rpc.request', 'rpc.request']);
  assert.deepEqual(server.events[2].detail, { method: 'thread/read', threadId: 'prior-thread' });
  assert.doesNotMatch(JSON.stringify(server.events), /secret-grant|secret-prompt|TOKEN/);
});
