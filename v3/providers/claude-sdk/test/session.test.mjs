import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeSession } from '../src/session.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeSdk({ initDelay = 0, initError = null, hangInit = false } = {}) {
  const state = { queries: 0 };
  return {
    state,
    query({ options }) {
      state.queries += 1;
      let releaseIterator;
      const query = {
        options,
        closed: false,
        async *[Symbol.asyncIterator]() { await new Promise(resolve => { releaseIterator = resolve; }); },
        async initializationResult() {
          if (hangInit) return new Promise(() => {});
          if (initDelay) await delay(initDelay);
          if (initError) throw initError;
          return { commands: [], agents: [], models: [], account: {}, output_style: 'default' };
        },
        async interrupt() {},
        close() { this.closed = true; releaseIterator?.(); },
        async return() { releaseIterator?.(); return { done: true }; },
      };
      return query;
    },
  };
}

function harness(options = {}) {
  const events = [];
  const sdk = fakeSdk(options);
  const session = new ClaudeSession({
    cardId: 'card-1',
    sdk,
    write: value => events.push(value),
    hostOptions: options.hostOptions ?? {},
  });
  return { session, events, sdk };
}

const within = async (ms, promise, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label}`)), ms);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
};

test('a pre-cancelled permission request resolves deny immediately without publishing a card', async () => {
  const { session, events } = harness();
  const controller = new AbortController();
  controller.abort();
  const result = await within(200, session.requestPermission('Bash', {}, { signal: controller.signal }), 'pre-cancelled requestPermission must settle');
  assert.equal(result.behavior, 'deny');
  assert.equal(session.pending.size, 0, 'settled request must leave no pending entry');
  assert.equal(events.filter(e => e.ev === 'session.request').length, 0, 'a cancelled request must not publish a clickable card');
  assert.equal(events.filter(e => e.ev === 'session.request_cancelled').length, 0, 'an unpublished request must not fabricate a completion notice');
});

test('cancelling a published request resolves deny once and reports the original request and turn', async () => {
  const { session, events } = harness();
  session.send('hello', 'op-7');
  const controller = new AbortController();
  const pending = session.requestPermission('Bash', {}, { signal: controller.signal });
  await delay(10);
  const published = events.find(e => e.ev === 'session.request');
  assert.ok(published, 'request must be published before cancellation');
  controller.abort();
  const result = await within(200, pending, 'cancelled requestPermission must settle');
  assert.equal(result.behavior, 'deny');
  const cancelled = events.filter(e => e.ev === 'session.request_cancelled');
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].requestId, published.requestId);
  assert.equal(cancelled[0].operationId, 'op-7', 'cancellation must carry the owning turn');
  assert.equal(session.pending.size, 0);
  await assert.rejects(() => Promise.resolve().then(() => session.decide(published.requestId, 'allow')), /unknown or expired/);
});

test('a user decision settles once; a late cancel emits nothing', async () => {
  const { session, events } = harness();
  const controller = new AbortController();
  const pending = session.requestPermission('Read', {}, { signal: controller.signal });
  await delay(10);
  const requestId = events.find(e => e.ev === 'session.request').requestId;
  session.decide(requestId, 'allow');
  assert.deepEqual(await within(200, pending, 'decided request must settle'), { behavior: 'allow' });
  controller.abort();
  await delay(20);
  assert.equal(events.filter(e => e.ev === 'session.request_cancelled').length, 0);
  assert.equal(session.pending.size, 0);
});

test('session close denies every pending permission with a cancellation notice', async () => {
  const { session, events } = harness();
  const first = session.requestPermission('Bash', {}, {});
  const second = session.requestPermission('Read', {}, {});
  await delay(10);
  await session.stop();
  assert.equal((await within(200, first, 'first pending settles on close')).behavior, 'deny');
  assert.equal((await within(200, second, 'second pending settles on close')).behavior, 'deny');
  assert.equal(events.filter(e => e.ev === 'session.request_cancelled').length, 2);
  assert.equal(session.pending.size, 0);
});

test('session.start resolves only after the SDK initialization handshake', async () => {
  const { session, events } = harness({ initDelay: 400 });
  let resolved = false;
  const started = session.start({ cwd: 'C:/', sessionId: null }).then(value => { resolved = true; return value; });
  await delay(120);
  assert.equal(resolved, false, 'start must wait for the real handshake, not the query constructor');
  await within(3000, started, 'start resolves after the handshake');
  await session.stop();
  assert.ok(events.some(e => e.ev === 'session.status'), 'status events still flow');
});

test('session.start rejects with the real handshake error and closes the query', async () => {
  const { session } = harness({ initError: new Error('not authenticated') });
  await assert.rejects(session.start({ cwd: 'C:/', sessionId: null }), /not authenticated/);
  assert.equal(session.query.closed, true, 'a failed handshake must not leave a running CLI');
  assert.equal(session.ended, true, 'a failed handshake marks the session ended');
});

test('session.start times out instead of waiting forever', async () => {
  const { session } = harness({ hangInit: true, hostOptions: { handshakeTimeoutMs: 300 } });
  await assert.rejects(session.start({ cwd: 'C:/', sessionId: null }), /timed out/);
  assert.equal(session.query.closed, true);
  assert.equal(session.ended, true);
});

test('stopping during the handshake aborts start without reviving the session', async () => {
  const { session } = harness({ hangInit: true });
  const started = session.start({ cwd: 'C:/', sessionId: null });
  await delay(50);
  const stopped = session.stop();
  await assert.rejects(started, /stopped|closed/i);
  await stopped;
  await delay(20);
  assert.equal(session.ended, true);
  assert.equal(session.closed, true);
});

test('a query that dies before its delayed initialization reply cannot make start ready', async () => {
  const events = [];
  const sdk = {
    query() {
      return {
        async *[Symbol.asyncIterator]() {},
        async initializationResult() { await delay(30); return { commands: [] }; },
        close() {},
      };
    },
  };
  const session = new ClaudeSession({ cardId: 'card-early-death', sdk, write: value => events.push(value) });
  await assert.rejects(within(200, session.start({ cwd: 'C:/', sessionId: null }), 'early query death must fail start'), /ended|closed/i);
  assert.equal(session.ended, true);
  assert.ok(events.some(value => value.ev === 'session.status' && value.phase === 'closed'));
});

test('a query error during initialization surfaces the SDK error', async () => {
  const sdk = {
    query() {
      return {
        async *[Symbol.asyncIterator]() { throw new Error('authentication setup failed'); },
        async initializationResult() { await delay(30); return { commands: [] }; },
        close() {},
      };
    },
  };
  const session = new ClaudeSession({ cardId: 'card-early-error', sdk, write() {} });
  await assert.rejects(within(200, session.start({ cwd: 'C:/', sessionId: null }), 'early query error'), /authentication setup failed/);
});

test('a request cancelled while its card is being published resolves after the card event', async () => {
  const events = [];
  const controller = new AbortController();
  const session = new ClaudeSession({
    cardId: 'card-reentrant', sdk: fakeSdk(),
    write(value) {
      events.push(value);
      if (value.ev === 'session.request') controller.abort();
    },
  });
  const decision = await within(200, session.requestPermission('Bash', {}, { signal: controller.signal }), 'reentrant cancellation');
  assert.equal(decision.behavior, 'deny');
  assert.deepEqual(events.map(value => value.ev), ['session.request', 'session.request_cancelled']);
});

test('cancellation retains the native identity captured when the approval was published', async () => {
  const { session, events } = harness();
  session.sessionId = 'native-original';
  const controller = new AbortController();
  const pending = session.requestPermission('Bash', {}, { signal: controller.signal });
  session.sessionId = 'native-later';
  controller.abort();
  assert.equal((await within(200, pending, 'identity-bound cancellation')).behavior, 'deny');
  assert.equal(events.find(value => value.ev === 'session.request_cancelled').sessionId, 'native-original');
});

test('a permission callback arriving after stop is denied without publishing a card', async () => {
  const { session, events } = harness();
  await session.stop();
  const outcome = await within(200, session.requestPermission('Bash', {}, {}), 'late permission after stop');
  assert.equal(outcome.behavior, 'deny');
  assert.equal(events.filter(value => value.ev === 'session.request').length, 0);
  assert.equal(session.pending.size, 0);
});
