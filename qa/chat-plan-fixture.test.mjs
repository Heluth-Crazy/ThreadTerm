import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

// qa/chat-plan-real.mjs drives the product with qa/fixtures/fake-codex-plan.cjs.
// The fixture is stricter than the Rust ones: an unhandled request is answered
// with an error, and the runtime treats a failed app-server request as a failed
// Chat connection. These tests pin the app-server requests a Codex Chat
// connection really sends (runtime/src/providers/codex.rs) so the fixture cannot
// drift behind the product and turn the harness red for the wrong reason.

function bootFixture() {
  const messages = [];
  let receive;
  const require = name => {
    if (name === 'node:fs') return { appendFileSync() {} };
    if (name === 'node:readline') return { createInterface: () => ({ on: (_event, callback) => { receive = callback; } }) };
    throw new Error(`Unexpected fixture dependency ${name}`);
  };
  const process = {
    env: { THREADTERM_QA_CODEX_PLAN_LOG: 'memory', THREADTERM_QA_CODEX_PLAN_CWD: 'fixture-work' },
    stdin: {}, stdout: { write: line => messages.push(JSON.parse(line)) }, exit: code => { throw new Error(`Unexpected fixture exit ${code}`); },
  };
  runInNewContext(readFileSync(resolve('qa/fixtures/fake-codex-plan.cjs'), 'utf8'), { require, process, setTimeout });
  let id = 0;
  return request => {
    messages.length = 0;
    receive(JSON.stringify({ id: ++id, method: request.method, params: request.params ?? {} }));
    const replies = messages.filter(message => message.id === id);
    assert.equal(replies.length, 1, `${request.method} answered exactly once`);
    assert.equal(replies[0].error, undefined, `${request.method} is answered with a result, not ${replies[0].error?.message}`);
    return { reply: replies[0], events: messages.filter(message => message.id === undefined) };
  };
}

test('the plan fixture answers the new-chat handshake the runtime sends before any turn', () => {
  const request = bootFixture();
  // Codex adapters initialize, start a thread, inject the persistence item that
  // makes the empty thread durable, and prove it with a second process's read.
  assert.ok(request({ method: 'initialize', params: { capabilities: { experimentalApi: true } } }).reply.result.capabilities);
  assert.equal(request({ method: 'thread/start', params: { cwd: 'fixture-work', threadSource: 'user' } }).reply.result.thread.id, 'qa-codex-plan-thread');
  assert.deepEqual(request({ method: 'thread/inject_items', params: { threadId: 'qa-codex-plan-thread', items: [{ type: 'message', role: 'developer', content: [] }] } }).reply.result, {});
  const read = request({ method: 'thread/read', params: { threadId: 'qa-codex-plan-thread', includeTurns: true } });
  assert.equal(read.reply.result.thread.id, 'qa-codex-plan-thread');
  // Codex history validation rejects a thread without a turns array.
  assert.deepEqual(read.reply.result.thread.turns, []);
  assert.ok(request({ method: 'model/list' }).reply.result.data.length > 0);
  assert.deepEqual(request({ method: 'skills/list' }).reply.result.data, []);
  assert.ok(request({ method: 'account/read' }).reply.result.account);
  assert.deepEqual(request({ method: 'account/rateLimits/read' }).reply.result, {});
  assert.ok(request({ method: 'thread/settings/update', params: { model: 'qa-model-a' } }).reply.result.thread);
});

test('a plan turn streams the native plan, the answer and the completion', () => {
  const request = bootFixture();
  const { reply, events } = request({ method: 'turn/start', params: { threadId: 'qa-codex-plan-thread', input: [] } });
  assert.equal(reply.result.turn.id, 'qa-native-turn-1');
  assert.deepEqual(events.map(event => event.method), ['turn/started', 'turn/plan/updated', 'item/completed', 'turn/completed']);
  const plan = events[1].params;
  assert.equal(plan.explanation, 'The agent wrote this plan before editing.');
  assert.deepEqual(plan.plan.map(step => step.status), ['completed', 'inProgress', 'pending']);
  assert.equal(events[3].params.turn.status, 'completed');
  assert.ok(request({ method: 'turn/interrupt', params: { threadId: 'qa-codex-plan-thread', turnId: 'qa-native-turn-2' } }).reply.result);
});
