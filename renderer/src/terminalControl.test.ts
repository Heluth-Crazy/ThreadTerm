import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalControl, type TerminalControlState } from './terminalControl';
import { createLeasePool } from './controlLease';

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('control state did not settle');
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('renewal loss automatically claims a fresh epoch and disposal releases only live control', async () => {
  let claims = 0, renews = 0, releases = 0;
  const pool = createLeasePool({ claim: async () => ++claims, renew: async () => { if (++renews === 1) throw new Error('stale_lease'); }, release: async () => { releases++; } }, 10);
  let state: TerminalControlState = { phase: 'disabled' };
  const controller = createTerminalControl(lost => pool('shell', lost), next => { state = next; }, [1, 2]);
  controller.setEnabled(true);
  try { await until(() => state.phase === 'ready' && state.epoch === 2); assert.equal(claims, 2); assert.equal(releases, 0); }
  finally { controller.dispose(); }
  assert.equal(releases, 1);
});

test('focus validation detects a stale lease immediately and shares one pending renew between panes', async () => {
  const pending = deferred<void>();
  let renews = 0, lost = 0;
  const pool = createLeasePool({ claim: async () => 1, renew: async () => { renews++; return pending.promise; }, release: async () => {} });
  const [one, two] = await Promise.all([pool('shell', () => { lost++; }), pool('shell', () => { lost++; })]);
  const checks = [one.check(), two.check()];
  await until(() => renews === 1);
  pending.reject(new Error('stale_lease'));
  assert.deepEqual((await Promise.allSettled(checks)).map(result => result.status), ['rejected', 'rejected']);
  assert.equal(lost, 2);
  one.release(); two.release();
});

test('another owner stays read-only without automatic claim loops, manual retry can restore input', async () => {
  let claims = 0, held = true;
  let state: TerminalControlState = { phase: 'disabled' };
  const controller = createTerminalControl(async () => {
    claims++; if (held) throw Object.assign(new Error('lease_held'), { code: 'lease_held' });
    return { epoch: 2, release() {}, check: async () => {} };
  }, next => { state = next; }, [1, 2]);
  controller.setEnabled(true);
  await until(() => state.phase === 'blocked');
  await controller.wake(); await controller.wake();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(claims, 1);
  held = false; await controller.retry();
  await until(() => state.phase === 'ready');
  assert.equal(state.epoch, 2); controller.dispose();
});

test('overlapping wakes and retries during a pending failure cannot exceed bounded claim attempts', async () => {
  const pending = deferred<never>();
  let claims = 0, state: TerminalControlState = { phase: 'disabled' };
  const controller = createTerminalControl(async () => {
    if (++claims === 1) return pending.promise;
    throw new Error('runtime unavailable');
  }, next => { state = next; }, [1, 2]);
  controller.setEnabled(true);
  await controller.retry(); await controller.retry(); await controller.wake();
  pending.reject(new Error('runtime unavailable'));
  await until(() => state.phase === 'failed');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(claims, 3); controller.dispose();
});

test('transient claim retries are bounded and cleanup cancels recovery', async () => {
  let claims = 0, state: TerminalControlState = { phase: 'disabled' };
  const controller = createTerminalControl(async () => { claims++; throw new Error('runtime unavailable'); }, next => { state = next; }, [1, 2]);
  controller.setEnabled(true);
  await until(() => state.phase === 'failed');
  assert.equal(claims, 3);
  controller.dispose(); await controller.retry();
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(claims, 3);
});

test('late claim after disable cannot revive input, re-enable waits and releases the obsolete claim', async () => {
  const pending = deferred<{ epoch: number; release(): void; check(): Promise<void> }>();
  let claims = 0, released = 0, state: TerminalControlState = { phase: 'disabled' };
  const controller = createTerminalControl(async () => ++claims === 1 ? pending.promise : { epoch: 2, release() {}, check: async () => {} }, next => { state = next; });
  controller.setEnabled(true); controller.setEnabled(false); controller.setEnabled(true);
  assert.equal(claims, 1);
  pending.resolve({ epoch: 1, release() { released++; }, check: async () => {} });
  await until(() => state.phase === 'ready');
  assert.equal(state.epoch, 2); assert.equal(released, 1); assert.equal(claims, 2); controller.dispose();
});

test('a delayed failure from a released lease cannot invalidate the replacement lease', async () => {
  const pending = deferred<void>();
  let claims = 0, replacementLost = 0;
  const pool = createLeasePool({ claim: async () => ++claims, renew: () => pending.promise, release: async () => {} });
  const old = await pool('shell', () => {}), checking = old.check();
  await Promise.resolve(); old.release();
  const replacement = await pool('shell', () => { replacementLost++; });
  pending.reject(new Error('stale_lease')); await assert.rejects(checking);
  assert.equal(replacement.epoch, 2); assert.equal(replacementLost, 0); replacement.release();
});
