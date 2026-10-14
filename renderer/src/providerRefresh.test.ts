import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeEvent } from '@threadterm/protocol';
import {
  IDLE_PROVIDER_REFRESH,
  PROVIDER_REFRESH_TIMEOUT_MS,
  observeProviderRefresh,
  providerRefreshCompletes,
  providerRefreshEvent,
  providerRefreshText,
  type ProviderRefreshOutcome,
  type ProviderRefreshState,
} from './providerRefresh';

const event = (data: unknown): RuntimeEvent => ({ v: 1, event: 'state.changed', epoch: 'provider-refresh-test', seq: 1, data });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(send: () => Promise<{ refreshId: number }> = async () => ({ refreshId: 7 })) {
  let listener: ((event: RuntimeEvent) => void) | undefined;
  const states: ProviderRefreshState[] = [];
  const outcomes: ProviderRefreshOutcome[] = [];
  const calls: string[] = [];
  let timer: (() => void) | undefined;
  const handle = observeProviderRefresh(
    async () => { calls.push('provider.refresh'); return send(); },
    next => { listener = next; return () => { listener = undefined; }; },
    state => states.push(state),
    {
      setTimer: handler => { timer = handler; return 1; },
      clearTimer: () => { timer = undefined; },
      onOutcome: outcome => outcomes.push(outcome),
    },
  );
  return {
    handle, states, outcomes, calls,
    emit: (data: unknown) => listener?.(event(data)),
    fireTimeout: () => { const pending = timer; timer = undefined; pending?.(); },
    hasTimer: () => Boolean(timer),
    lastState: () => states.at(-1),
  };
}

test('refresh calls provider.refresh and shows checking before the reply arrives', async () => {
  const gate = deferred<{ refreshId: number }>();
  const qa = harness(() => gate.promise);
  const pending = qa.handle.refresh();
  assert.deepEqual(qa.calls, ['provider.refresh'], 'the forced path must never call provider.list');
  assert.deepEqual(qa.lastState(), { phase: 'checking' }, 'the button shows checking immediately');
  assert.equal(qa.hasTimer(), true, 'the 120 s status timer is armed from the click');
  assert.equal(PROVIDER_REFRESH_TIMEOUT_MS, 120_000);
  gate.resolve({ refreshId: 7 });
  await pending;
  assert.deepEqual(qa.lastState(), { phase: 'checking', refreshId: 7 });
});

test('a completion that arrives before the RPC reply still finishes the round', async () => {
  const gate = deferred<{ refreshId: number }>();
  const qa = harness(() => gate.promise);
  const pending = qa.handle.refresh();
  qa.emit({ kind: 'providers', generation: 7, outcome: 'ok' });
  assert.equal(qa.lastState()?.phase, 'checking', 'the early completion is buffered, not applied');
  gate.resolve({ refreshId: 7 });
  await pending;
  assert.equal(qa.lastState()?.phase, 'updated');
  assert.deepEqual(qa.outcomes, ['ok']);
  assert.equal(qa.hasTimer(), false, 'the buffered completion cleared the timer');
});

test('a pre-reply completion from an older round does not finish the check', async () => {
  const gate = deferred<{ refreshId: number }>();
  const qa = harness(() => gate.promise);
  const pending = qa.handle.refresh();
  qa.emit({ kind: 'providers', generation: 6, outcome: 'ok' });
  gate.resolve({ refreshId: 7 });
  await pending;
  assert.equal(qa.lastState()?.phase, 'checking');
  assert.deepEqual(qa.outcomes, []);
  qa.emit({ kind: 'providers', generation: 7, outcome: 'failed' });
  assert.equal(qa.lastState()?.phase, 'failed');
});

test('only a providers completion at or after the refresh id ends the round', async () => {
  const qa = harness();
  await qa.handle.refresh();
  qa.emit({ kind: 'plugins', generation: 7, outcome: 'ok' });
  qa.emit({ kind: 'providers' });
  qa.emit({ kind: 'providers', generation: 6, outcome: 'ok' });
  qa.emit(null);
  assert.deepEqual(qa.lastState(), { phase: 'checking', refreshId: 7 }, 'unrelated events must not end checking');
  assert.deepEqual(qa.outcomes, []);
  assert.equal(qa.hasTimer(), true, 'a non-matching event must not clear the timeout');
  qa.emit({ kind: 'providers', generation: 7, outcome: 'ok' });
  assert.equal(qa.lastState()?.phase, 'updated');
  assert.deepEqual(qa.outcomes, ['ok']);
  assert.equal(qa.hasTimer(), false, 'completion clears the status timer');
});

test('a plugin-started newer generation supersedes and finishes the check', async () => {
  const qa = harness();
  await qa.handle.refresh();
  qa.emit({ kind: 'providers', generation: 9, outcome: 'failed' });
  assert.equal(qa.lastState()?.phase, 'failed', 'a newer round completes the check with its outcome');
  assert.deepEqual(qa.outcomes, ['failed']);
});

test('a newer refresh supersedes an older round and the older completion is ignored', async () => {
  let nextId = 7;
  const qa = harness(async () => ({ refreshId: nextId++ }));
  await qa.handle.refresh();
  await qa.handle.refresh();
  assert.equal(qa.lastState()?.refreshId, 8);
  qa.emit({ kind: 'providers', generation: 7, outcome: 'failed' });
  assert.equal(qa.lastState()?.phase, 'checking', 'an older completion does not end the newer round');
  assert.deepEqual(qa.outcomes, []);
  qa.emit({ kind: 'providers', generation: 8, outcome: 'ok' });
  assert.equal(qa.lastState()?.phase, 'updated');
});

test('the timeout keeps the round open and a late failure still applies', async () => {
  const qa = harness();
  await qa.handle.refresh();
  qa.fireTimeout();
  assert.deepEqual(qa.lastState(), { phase: 'timeout', refreshId: 7 });
  qa.emit({ kind: 'providers', generation: 7, outcome: 'failed' });
  assert.equal(qa.lastState()?.phase, 'failed');
  assert.deepEqual(qa.outcomes, ['failed']);
});

test('a disposed tracker ignores later events and never notifies the update sink', async () => {
  const qa = harness();
  await qa.handle.refresh();
  const seen = qa.states.length;
  qa.handle.dispose();
  qa.emit({ kind: 'providers', generation: 7, outcome: 'ok' });
  assert.equal(qa.states.length, seen, 'events after dispose must not reach the UI');
  assert.deepEqual(qa.outcomes, []);
});

test('a rejected provider.refresh request resets to idle and rejects', async () => {
  const qa = harness(async () => { throw new Error('runtime unavailable'); });
  await assert.rejects(qa.handle.refresh(), /runtime unavailable/);
  assert.equal(qa.lastState()?.phase, 'idle');
  assert.equal(qa.hasTimer(), false);
});

test('the event helpers stay total for malformed provider payloads', () => {
  assert.deepEqual(providerRefreshEvent({ kind: 'providers' }), { generation: undefined, outcome: undefined });
  assert.deepEqual(providerRefreshEvent({ kind: 'providers', generation: 2, outcome: 'ok' }), { generation: 2, outcome: 'ok' });
  assert.equal(providerRefreshEvent({ kind: 'providers', generation: 2, outcome: 'other' })?.outcome, undefined);
  assert.deepEqual(providerRefreshEvent({ kind: 'providers', generation: -1 }), { generation: undefined, outcome: undefined });
  assert.deepEqual(providerRefreshEvent({ kind: 'providers', generation: 1.5 }), { generation: undefined, outcome: undefined });
  assert.equal(providerRefreshEvent('providers'), undefined);
  assert.equal(providerRefreshEvent([{ kind: 'providers' }]), undefined);
  assert.equal(providerRefreshCompletes(3, 3), true);
  assert.equal(providerRefreshCompletes(3, 4), true);
  assert.equal(providerRefreshCompletes(3, 2), false);
  assert.equal(providerRefreshCompletes(3, undefined), false);
  assert.deepEqual(IDLE_PROVIDER_REFRESH, { phase: 'idle' });
});

test('the refresh states carry en and zh-CN copy', () => {
  const en = providerRefreshText('en');
  const zh = providerRefreshText('zh-CN');
  assert.match(en.refresh, /Refresh provider status/);
  assert.equal(en.checking, 'Checking providers…');
  assert.match(en.updated, /Provider status updated/);
  assert.match(en.failed, /Showing the last known status/);
  assert.match(en.timeout, /Still checking providers/);
  assert.match(en.detectionFailed, /Refresh provider status to try again/);
  assert.equal(zh.refresh, '刷新提供商状态');
  assert.equal(zh.checking, '正在检测提供商…');
  assert.equal(zh.updated, '提供商状态已更新。');
  assert.match(zh.failed, /正在显示上次检测结果/);
  assert.match(zh.timeout, /仍在检测提供商/);
  assert.match(zh.detectionFailed, /刷新提供商状态/);
});
