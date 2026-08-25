import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertHarnessAbsent, closeShell, createShell, floatAttachHideRevealReturn, invoke, nonceReadback, resizeAndReveal, type SmokeCounters, waitForSurface, withMatrixEvidence } from './helpers';

const reportPath = process.env.THREADTERM_WDIO_REPORT;

function record(ok: boolean, counters: SmokeCounters, started: number, managedDataRoot: string, pinnedEntries: string): void {
  if (!reportPath) return;
  mkdirSync(dirname(reportPath), { recursive: true });
  appendFileSync(reportPath, `${JSON.stringify(withMatrixEvidence({
    kind: 'public-ui-float-attach', artifact: process.env.THREADTERM_WDIO_ARTIFACT ?? 'production',
    selectorActivation: 'shippingCommand', webviewUserDataFolder: process.env.THREADTERM_WDIO_UDF ? 'isolated' : 'missing',
    managedDataRoot, pinnedEntries, ok, elapsedMs: Date.now() - started, counters,
  }))}\n`);
}

describe('production release float attach smoke', () => {
  it('moves a writable shell through float hide, reveal, and recycle', async () => {
    const started = Date.now();
    const counters: SmokeCounters = { writable: 0, resize: 0, hiddenReveal: 0, closed: 0, harnessUnknown: 0, floatAttach: 0, floatHideReveal: 0, recycle: 0 };
    let managedDataRoot = 'unknown';
    let pinnedEntries = 'notChecked';
    try {
      await waitForSurface();
      const status = await invoke('data_directory_status', {});
      const actualRoot = status.ok && status.value && typeof status.value === 'object'
        ? (status.value as { root?: unknown }).root : undefined;
      const normalize = (value: string) => value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
      managedDataRoot = typeof actualRoot === 'string' && process.env.THREADTERM_WDIO_DATA_ROOT
        && normalize(actualRoot) === normalize(process.env.THREADTERM_WDIO_DATA_ROOT) ? 'isolated' : 'mismatch';
      if (managedDataRoot !== 'isolated') throw new Error('managed-data-root-mismatch');
      pinnedEntries = await browser.execute(() => {
        try {
          const parsed = JSON.parse(localStorage.getItem('threadterm-terminal-store') ?? '{}');
          const state = parsed.state ?? parsed;
          const pins = Array.isArray(state.pinnedCardIds) ? state.pinnedCardIds : [];
          const cards = Array.isArray(state.cards) ? state.cards : [];
          return pins.length === 0 ? 'none' : pins.every((id: unknown) => !cards.some((card: { id?: unknown }) => card.id === id)) ? 'stale' : 'present';
        } catch { return 'unknown'; }
      });
      const label = await createShell();
      await nonceReadback();
      counters.writable = 1;
      await resizeAndReveal(counters);
      await floatAttachHideRevealReturn(counters, label);
      await nonceReadback();
      counters.writable = 2;
      await closeShell(counters);
      counters.harnessUnknown = await assertHarnessAbsent();
      record(true, counters, started, managedDataRoot, pinnedEntries);
    } catch (error) {
      record(false, counters, started, managedDataRoot, pinnedEntries);
      throw error;
    }
  });
});
