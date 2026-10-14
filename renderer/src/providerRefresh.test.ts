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

test('refresh calls provider.refresh and enters the checking state with the returned id', async () => {
  const qa = harness();
  await qa.handle.refresh();
  assert.deepEqual(qa.calls, ['provider.refresh'], 'the forced path must never call provider.list');
  assert.deepEqual(qa.lastState(), { phase: 'checking', refreshId: 7 });
  assert.equal(qa.hasTimer(), true, 'a checking round arms its 120 s status timer');
  assert.equal(PROVIDER_REFRESH_TIMEOUT_MS, 120_000);
});

test('only a matching providers completion ends the round', async () => {
  const qa = harness();
  await qa.handle.refresh();
  qa.emit({ kind: 'plugins', refreshId: 7, outcome: 'ok' });
  qa.emit({ kind: 'providers' });
  qa.emit({ kind: 'providers', refreshId: 6, outcome: 'ok' });
  qa.emit(null);
  assert.deepEqual(qa.lastState(), { phase: 'checking', refreshId: 7 }, 'unrelated events must not end checking');
  assert.deepEqual(qa.outcomes, []);
  assert.equal(qa.hasTimer(), true, 'a non-matching event must not clear the timeout');
  qa.emit({ kind: 'providers', refreshId: 7, outcome: 'ok' });
  assert.equal(qa.lastState()?.phase, 'updated');
  assert.deepEqual(qa.outcomes, ['ok']);
  assert.equal(qa.hasTimer(), false, 'completion clears the status timer');
});

test('a newer refresh supersedes an older round and the older completion is ignored', async () => {
  let nextId = 7;
  const qa = harness(async () => ({ refreshId: nextId++ }));
  await qa.handle.refresh();
  await qa.handle.refresh();
  assert.equal(qa.lastState()?.refreshId, 8);
  qa.emit({ kind: 'providers', refreshId: 7, outcome: 'failed' });
  assert.equal(qa.lastState()?.phase, 'checking', 'an older completion does not end the newer round');
  assert.deepEqual(qa.outcomes, []);
  qa.emit({ kind: 'providers', refreshId: 9, outcome: 'ok' });
  assert.equal(qa.lastState()?.phase, 'updated', 'a newer-than-expected completion still lands');
  assert.deepEqual(qa.outcomes, ['ok']);
});

test('the timeout keeps the round open and a late failure still applies', async () => {
  const qa = harness();
  await qa.handle.refresh();
  qa.fireTimeout();
  assert.deepEqual(qa.lastState(), { phase: 'timeout', refreshId: 7 });
  qa.emit({ kind: 'providers', refreshId: 7, outcome: 'failed' });
  assert.equal(qa.lastState()?.phase, 'failed');
  assert.deepEqual(qa.outcomes, ['failed']);
});

test('a disposed tracker ignores later events and never notifies the update sink', async () => {
  const qa = harness();
  await qa.handle.refresh();
  const seen = qa.states.length;
  qa.handle.dispose();
  qa.emit({ kind: 'providers', refreshId: 7, outcome: 'ok' });
  assert.equal(qa.states.length, seen, 'events after dispose must not reach the UI');
  assert.deepEqual(qa.outcomes, []);
});

test('a rejected provider.refresh request rejects so the panel can show the runtime error', async () => {
  let listener: ((event: RuntimeEvent) => void) | undefined;
  const handle = observeProviderRefresh(
    async () => { throw new Error('runtime unavailable'); },
    next => { listener = next; return () => { listener = undefined; }; },
    () => {},
  );
  await assert.rejects(handle.refresh(), /runtime unavailable/);
});

test('the event helpers stay total for malformed provider payloads', () => {
  assert.deepEqual(providerRefreshEvent({ kind: 'providers' }), { refreshId: undefined, outcome: undefined });
  assert.deepEqual(providerRefreshEvent({ kind: 'providers', refreshId: 2, outcome: 'ok' }), { refreshId: 2, outcome: 'ok' });
  assert.equal(providerRefreshEvent({ kind: 'providers', refreshId: 2, outcome: 'other' })?.outcome, undefined);
  assert.deepEqual(providerRefreshEvent({ kind: 'providers', refreshId: -1 }), { refreshId: undefined, outcome: undefined });
  assert.deepEqual(providerRefreshEvent({ kind: 'providers', refreshId: 1.5 }), { refreshId: undefined, outcome: undefined });
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
