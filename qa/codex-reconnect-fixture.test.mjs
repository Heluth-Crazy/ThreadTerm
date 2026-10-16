import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

function bootFixture() {
  const messages = [];
  let receive;
  const require = name => {
    if (name === 'node:fs') return { appendFileSync() {}, existsSync: () => false };
    if (name === 'node:readline') return { createInterface: () => ({ on: (_event, callback) => { receive = callback; } }) };
    throw new Error(`Unexpected fixture dependency ${name}`);
  };
  const process = {
    env: { THREADTERM_QA_CODEX_RECONNECT_LOG: 'memory', THREADTERM_QA_CODEX_RECONNECT_CWD: 'fixture-work', THREADTERM_QA_CODEX_RECONNECT_CONTROL: 'fixture-control' },
    stdin: {}, stdout: { write: line => messages.push(JSON.parse(line)) }, exit: code => { throw new Error(`Unexpected fixture exit ${code}`); },
  };
  runInNewContext(readFileSync(resolve('qa/fixtures/fake-codex-reconnect.cjs'), 'utf8'), { require, process, setTimeout });
  return {
    request: value => receive(JSON.stringify(value)),
    response: id => messages.find(value => value.id === id),
  };
}

test('reconnect fixture supports empty new-chat verification through another app-server', () => {
  const fixture = bootFixture();
  fixture.request({ id: 1, method: 'thread/inject_items', params: { threadId: 'created-thread', items: [] } });
  fixture.request({ id: 2, method: 'thread/read', params: { threadId: 'created-thread', includeTurns: true } });
  fixture.request({ id: 3, method: 'thread/resume', params: { threadId: 'created-thread' } });

  assert.deepEqual(fixture.response(1).result, {});
  assert.deepEqual(fixture.response(2).result.thread.id, 'created-thread');
  assert.deepEqual(fixture.response(2).result.thread.turns, []);
  assert.deepEqual(fixture.response(3).result.thread.id, 'created-thread');
  assert.deepEqual(fixture.response(3).result.thread.turns, []);
});
