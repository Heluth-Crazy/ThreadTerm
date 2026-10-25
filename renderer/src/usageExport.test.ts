import assert from 'node:assert/strict';
import test from 'node:test';
import type { UsageLedgerSessionDetail, UsageRecord } from '@threadterm/protocol';
import { readUsageExport, type UsageExportReader } from './usageExport';

const session = (nativeId?: string) => ({ id: 'threadterm-session', provider: 'fixture', nativeId });
const detail = (total: number, models: string[]): UsageLedgerSessionDetail => ({ tokens: { total }, models } as UsageLedgerSessionDetail);
const legacy: UsageRecord[] = [{ sessionId: 'threadterm-session', provider: 'fixture', recordedAt: '2026-10-25T00:00:00Z', inputTokens: 100, outputTokens: 10, model: 'legacy-model' }];
const reader = (ledgerSession: UsageExportReader['ledgerSession'], legacySession: UsageExportReader['legacySession'] = async () => legacy): UsageExportReader => ({ ledgerSession, legacySession });

test('native export keeps the ledger disjoint total, including cache that the legacy table omits', async () => {
  let legacyReads = 0;
  const result = await readUsageExport(session('native-1'), reader(async () => detail(510, ['canonical-model']), async () => { legacyReads++; return legacy; }));
  assert.deepEqual(result, { model: 'canonical-model', tokens: { total: 510 } });
  assert.equal(legacyReads, 0);
  assert.equal(legacy[0]!.inputTokens! + legacy[0]!.outputTokens!, 110, 'the old table demonstrably undercounts cached ledger usage');
});

test('native export omits an ambiguous model and leaves null ledger detail unreported', async () => {
  assert.deepEqual(await readUsageExport(session('native-2'), reader(async () => detail(42, ['first', 'second']))), { model: undefined, tokens: { total: 42 } });
  assert.deepEqual(await readUsageExport(session('native-3'), reader(async () => null)), {});
});

test('only a session without a native id uses the legacy table; a ledger failure never silently falls back', async () => {
  let legacyReads = 0;
  const fallback = await readUsageExport(session(), reader(async () => { throw new Error('ledger must not be called'); }, async () => { legacyReads++; return legacy; }));
  assert.deepEqual(fallback, { model: 'legacy-model', tokens: { input: 100, output: 10, total: 110 } });
  await assert.rejects(readUsageExport(session('native-4'), reader(async () => { throw new Error('ledger unavailable'); }, async () => { legacyReads++; return legacy; })), /ledger unavailable/);
  assert.equal(legacyReads, 1);
});
