import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {removeScratch, stopChild, waitForChildExit} from './qa-cleanup.mjs';

class FakeChild extends EventEmitter {
  pid = 123;
  exitCode = null;
  signalCode = null;
  kills = [];
  kill(signal) { this.kills.push(signal ?? 'default'); return true; }
  exit(code = 0) { this.exitCode = code; this.emit('exit', code); }
}

test('waitForChildExit resolves an already exited child', async () => {
  const child = new FakeChild();
  child.exit(0);
  await waitForChildExit(child);
});

test('stopChild waits for the owned child exit', async () => {
  const child = new FakeChild();
  const stopping = stopChild(child, {wait: async current => { current.exit(0); }});
  await stopping;
  assert.deepEqual(child.kills, ['default']);
});

test('waitForChildExit observes a later exit and releases its listeners', async () => {
  const child = new FakeChild();
  const waiting = waitForChildExit(child);
  assert.equal(child.listenerCount('exit'), 1);
  child.exit(0);
  await waiting;
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('waitForChildExit rejects on timeout and releases its listeners', async () => {
  const child = new FakeChild();
  await assert.rejects(waitForChildExit(child, {label: 'runtime', timeoutMs: 1}), /runtime did not exit/);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('stopChild registers the exit listener before terminating', async () => {
  const child = new FakeChild();
  child.kill = () => { child.exit(0); return true; };
  await stopChild(child);
});

test('stopChild escalates a timeout and waits for forced termination', async () => {
  const child = new FakeChild();
  let attempts = 0;
  await stopChild(child, {wait: async current => {
    if (++attempts === 1) throw new Error('graceful timeout');
    current.exit(0);
  }});
  assert.deepEqual(child.kills, ['default', 'SIGKILL']);
  assert.equal(attempts, 2);
});

test('stopChild preserves both failed termination attempts', async () => {
  const child = new FakeChild();
  const errors = [new Error('graceful timeout'), new Error('forced timeout')];
  let attempts = 0;
  await assert.rejects(stopChild(child, {wait: async () => { throw errors[attempts++]; }}), error => {
    assert.equal(error, errors[1]);
    assert.equal(error.cause, errors[0]);
    return true;
  });
});

test('stopChild skips a child whose spawn failed', async () => {
  const child = new FakeChild();
  child.pid = undefined;
  await stopChild(child);
  assert.deepEqual(child.kills, []);
});

test('removeScratch retries only transient Windows locks', async () => {
  let calls = 0;
  const delays = [];
  await removeScratch('scratch', {
    rmImpl: async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('busy'), {code: 'EBUSY'});
    },
    retryDelayMs: 1,
    sleepImpl: async delay => { delays.push(delay); },
  });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1, 1]);
});

test('removeScratch preserves non-retryable filesystem errors', async () => {
  await assert.rejects(
    removeScratch('scratch', {rmImpl: async () => { throw Object.assign(new Error('denied'), {code: 'EACCES'}); }}),
    /denied/
  );
});

test('removeScratch bounds retries and preserves the last lock error', async () => {
  const locked = Object.assign(new Error('still locked'), {code: 'EPERM'});
  let calls = 0;
  await assert.rejects(removeScratch('scratch', {
    rmImpl: async () => { calls++; throw locked; },
    maxRetries: 2,
    sleepImpl: async () => {},
  }), error => error === locked);
  assert.equal(calls, 3);
});
