import type { UsageScanState } from './usageLedger';
import { usageCopy } from './usageCopy';
import type { UsageLocale } from './usageFormat';
import type { UsageLedgerSource } from '@threadterm/protocol';

type Clock = { now: () => number; setTimer: (callback: () => void, delay: number) => () => void };
const clock: Clock = {
  now: () => performance.now(),
  setTimer: (callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); },
};

/** One leading read and one pending trailing read; no timer exists without a progress event. */
export function createUsageProgressThrottle(reload: () => void, time: Clock = clock, interval = 5_000) {
  let last = -Infinity, pending = false, disposed = false;
  let clear: (() => void) | undefined;
  const run = () => { clear = undefined; pending = false; last = time.now(); if (!disposed) reload(); };
  return {
    progress() {
      if (disposed) return;
      if (time.now() - last >= interval) { clear?.(); run(); }
      else {
        pending = true;
        if (!clear) clear = time.setTimer(() => { clear = undefined; if (pending && !disposed) run(); }, interval - (time.now() - last));
      }
    },
    cancel() { clear?.(); clear = undefined; pending = false; last = -Infinity; },
    dispose() { disposed = true; clear?.(); clear = undefined; pending = false; },
  };
}

export function usageScanNotice(scan: UsageScanState | undefined, firstScan: boolean, locale: UsageLocale, providerName: (id: string) => string) {
  const copy = usageCopy(locale).scan;
  if (!scan || scan.state === 'completed') return undefined;
  if (scan.state === 'failed') return { kind: 'failed' as const, title: copy.failed, detail: undefined, code: scan.error ?? undefined, action: copy.retry };
  if (scan.state === 'cancelled') return { kind: 'cancelled' as const, title: copy.cancelled, detail: undefined, code: undefined, action: copy.continue };
  return {
    kind: 'running' as const,
    title: scan.phase === 'pricing' ? copy.countingPrices : copy.counting(scan.provider ? providerName(scan.provider) : '', scan.filesRead, scan.filesFound),
    detail: firstScan ? copy.firstRead : copy.soFar,
    code: undefined,
    action: copy.stop,
  };
}

export function usageScanErrorCode(error: unknown): string {
  const candidate = error && typeof error === 'object' && 'code' in error ? error.code : error instanceof Error ? error.message : error;
  return typeof candidate === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(candidate) ? candidate : 'usage_scan_failed';
}

export function hasReadProviderHistory(sources: readonly Pick<UsageLedgerSource, 'status' | 'lastRead' | 'stats' | 'missingSources'>[]): boolean {
  return sources.some(source => source.missingSources > 0 || (source.lastRead != null && (source.status === 'ready' || source.status === 'partial'
    || ((source.status === 'cancelled' || source.status === 'failed') && (source.stats.filesRead > 0 || source.stats.facts > 0)))));
}

export function canRefreshUsageSessions(visible: boolean, interacting: boolean): boolean {
  return visible && !interacting;
}

/** Catch up on visibility/focus changes without reading faster than progress permits. */
export function createUsageSessionRefresh(reload: () => void, time: Clock = clock) {
  let latest = 0, consumed = 0, eligible = false;
  const updates = createUsageProgressThrottle(() => {
    if (eligible && latest > consumed) { consumed = latest; reload(); }
  }, time);
  return {
    update(version: number, allowed: boolean) { latest = version; eligible = allowed; if (eligible && latest > consumed) updates.progress(); },
    finish(version: number) { consumed = version; latest = version; updates.cancel(); },
    dispose: updates.dispose,
  };
}
