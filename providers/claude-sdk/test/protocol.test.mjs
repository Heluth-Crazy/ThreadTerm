import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../src/protocol.mjs';
import { createInputQueue } from '../src/session.mjs';

test('protocol rejects unknown operations', () => {
  assert.match(parseLine('{"id":1,"op":"unsafe"}').error, /unknown op/);
});

test('protocol accepts chat option and question answer operations', () => {
  assert.deepEqual(parseLine('{"id":2,"op":"session.set_option","cardId":"c","optionId":"mode","value":"plan"}').request.op, 'session.set_option');
  assert.deepEqual(parseLine('{"id":3,"op":"session.answer","cardId":"c","requestId":"q","values":{"q0":["Blue"]}}').request.op, 'session.answer');
});

test('input queue preserves messages and closes', async () => {
  const queue = createInputQueue(); const iterator = queue[Symbol.asyncIterator]();
  queue.push('one'); assert.deepEqual(await iterator.next(), { value: 'one', done: false });
  queue.end(); assert.deepEqual(await iterator.next(), { value: undefined, done: true });
});
