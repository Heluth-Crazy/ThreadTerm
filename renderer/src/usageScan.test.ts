import test from 'node:test';
import assert from 'node:assert/strict';
import { canRefreshUsageSessions, createUsageProgressThrottle, createUsageSessionRefresh, hasReadProviderHistory, usageScanErrorCode, usageScanNotice } from './usageScan';
import type { UsageLedgerSource } from '@threadterm/protocol';
import { createElement } from 'react';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { UsageScanNotice } from './components/UsageScanNotice';

const { renderToStaticMarkup } = createRequire(join(process.cwd(), 'package.json'))('react-dom/server') as typeof import('react-dom/server');

function fakeClock() {
  let now = 0, id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimer(callback: () => void, delay: number) { const key = ++id; timers.set(key, { at: now + delay, callback }); return () => { timers.delete(key); }; },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].callback();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

test('progress reads lead immediately and trail once per five seconds after the last event', () => {
  const time = fakeClock(), reads: number[] = [];
  const throttle = createUsageProgressThrottle(() => reads.push(time.now()), time);
  time.advance(60_000); assert.deepEqual(reads, []); assert.equal(time.pending(), 0);
  throttle.progress(); assert.deepEqual(reads, [60_000]);
  for (let i = 0; i < 49; i++) { time.advance(100); throttle.progress(); }
  assert.deepEqual(reads, [60_000]); assert.equal(time.pending(), 1);
  time.advance(100); assert.deepEqual(reads, [60_000, 65_000]);
  time.advance(60_000); assert.deepEqual(reads, [60_000, 65_000]); assert.equal(time.pending(), 0);
});

test('terminal events cancel the trailing read and a new scan gets a leading read', () => {
  const time = fakeClock(), reads: number[] = [];
  const throttle = createUsageProgressThrottle(() => reads.push(time.now()), time);
  throttle.progress(); time.advance(100); throttle.progress(); throttle.cancel();
  time.advance(5_000); assert.deepEqual(reads, [0]); assert.equal(time.pending(), 0);
  throttle.progress(); assert.deepEqual(reads, [0, 5_100]);
});

test('unmount disposes pending progress and ignores subsequent events', () => {
  const time = fakeClock(); let reads = 0;
  const throttle = createUsageProgressThrottle(() => reads++, time);
  throttle.progress(); time.advance(100); throttle.progress(); throttle.dispose();
  time.advance(20_000); throttle.progress(); assert.equal(reads, 1); assert.equal(time.pending(), 0);
});

test('scan presentation distinguishes counting, first scan, failure and cancellation in en and zh', () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    const scan = { scanId: 'fixture-scan', state: 'running' as const, provider: 'codex', filesRead: 412, filesFound: 1567 };
    const running = usageScanNotice(scan, false, locale, () => 'Codex')!;
    assert.equal(running.kind, 'running'); assert.match(running.title, /Codex 412 \/ 1567/);
    assert.match(running.title, locale === 'en' ? /Counting/ : /正在统计/);
    assert.match(running.detail!, locale === 'en' ? /so far/ : /目前/);
    const runningHtml = renderToStaticMarkup(createElement(UsageScanNotice, { notice: running, onAction() {} }));
    assert.match(runningHtml, /aria-live="off"/, 'per-file counters do not generate repeated screen-reader announcements');
    const first = usageScanNotice(scan, true, locale, () => 'Codex')!;
    assert.match(first.detail!, locale === 'en' ? /first time.*few minutes.*fill in/ : /首次.*几分钟.*逐步/);
    const failed = usageScanNotice({ ...scan, state: 'failed', error: 'usage_ledger_busy' }, false, locale, () => 'Codex')!;
    assert.equal(failed.kind, 'failed'); assert.equal(failed.code, 'usage_ledger_busy');
    assert.match(failed.title, locale === 'en' ? /Couldn't read.*only include.*own chats/ : /无法读取.*仅包含.*自身对话/);
    assert.equal(failed.action, locale === 'en' ? 'Try again' : '重试');
    const failedHtml = renderToStaticMarkup(createElement(UsageScanNotice, { notice: failed, onAction() {} }));
    assert.match(failedHtml, /role="alert"/); assert.match(failedHtml, /class="btn btn-sm"/); assert.match(failedHtml, /usage_ledger_busy/);
    const cancelled = usageScanNotice({ ...scan, state: 'cancelled' }, false, locale, () => 'Codex')!;
    assert.equal(cancelled.kind, 'cancelled'); assert.match(cancelled.title, locale === 'en' ? /stopped.*incomplete/ : /已停止.*不完整/);
    assert.equal(cancelled.action, locale === 'en' ? 'Continue' : '继续');
    const cancelledHtml = renderToStaticMarkup(createElement(UsageScanNotice, { notice: cancelled, onAction() {} }));
    assert.match(cancelledHtml, /role="status"/); assert.ok(cancelledHtml.includes(cancelled.action));
    assert.equal(usageScanNotice({ ...scan, state: 'completed' }, false, locale, () => 'Codex'), undefined);
  }
});

test('only visible idle session lists accept live refreshes', () => {
  assert.equal(canRefreshUsageSessions(true, false), true);
  assert.equal(canRefreshUsageSessions(false, false), false);
  assert.equal(canRefreshUsageSessions(true, true), false);
});

test('scan errors expose a short code without arbitrary failure details', () => {
  assert.equal(usageScanErrorCode({ code: 'usage_ledger_busy' }), 'usage_ledger_busy');
  assert.equal(usageScanErrorCode(new Error('provider_io')), 'provider_io');
  assert.equal(usageScanErrorCode(new Error('Arbitrary detailed failure')), 'usage_scan_failed');
});

test('session lists catch up when visible and idle, coalescing eligibility changes and disposing on unmount', () => {
  const time = fakeClock(), reads: number[] = [];
  const updates = createUsageSessionRefresh(() => reads.push(time.now()), time);
  updates.update(1, false); time.advance(10_000); assert.deepEqual(reads, []);
  updates.update(1, true); assert.deepEqual(reads, [10_000]);
  time.advance(100); updates.update(2, false); updates.update(2, true);
  time.advance(4_899); assert.deepEqual(reads, [10_000]);
  time.advance(1); assert.deepEqual(reads, [10_000, 15_000]);
  updates.update(3, true); updates.finish(3); time.advance(5_000);
  assert.deepEqual(reads, [10_000, 15_000], 'the final aggregate reload supersedes a pending live read');
  updates.update(4, false); updates.update(4, true); updates.update(5, true); updates.dispose();
  time.advance(10_000); assert.deepEqual(reads, [10_000, 15_000, 20_000]); assert.equal(time.pending(), 0);
});

test('first history read uses persisted native source state, independent of range totals or own-chat facts', () => {
  const source = (status: UsageLedgerSource['status'], lastRead: string | null, filesRead = 0, missingSources = 0) => ({ status, lastRead, missingSources, stats: { filesRead, facts: filesRead } }) as Pick<UsageLedgerSource, 'status' | 'lastRead' | 'stats' | 'missingSources'>;
  assert.equal(hasReadProviderHistory([]), false);
  assert.equal(hasReadProviderHistory([source('ready', null)]), false);
  assert.equal(hasReadProviderHistory([source('not_installed', '2026-01-01')]), false);
  assert.equal(hasReadProviderHistory([source('not_installed', '2026-01-01', 0, 1)]), true, 'retained history stays a prior read after its folder disappears');
  assert.equal(hasReadProviderHistory([source('not_supported_yet', '2026-01-01')]), false);
  assert.equal(hasReadProviderHistory([source('history_not_read', null, 20)]), false, 'own-chat usage is not a native history read');
  assert.equal(hasReadProviderHistory([source('ready', '2026-01-01')]), true, 'an empty selected range cannot turn a prior native read into a first scan');
  assert.equal(hasReadProviderHistory([source('cancelled', '2026-01-01')]), false);
  assert.equal(hasReadProviderHistory([source('cancelled', '2026-01-01', 1)]), true);
});
