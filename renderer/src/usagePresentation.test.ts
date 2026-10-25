import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateActiveTime, chartTipPosition, sessionActiveTime, usageDays } from './usagePresentation';
import type { UsageLedgerSeries } from '@threadterm/protocol';
import { thinLabels } from './usageSeries';
import { problemCounts, sourceProblemMatchesState } from './usageSources';
import { usageCopy } from './usageCopy';

test('usage days count requests on daily points even when native duration is absent', () => {
  const series = { from: '2026-01-01', to: '2026-01-05', granularity: 'day', points: [
    { start: '2026-01-01', requests: 1, activeTimeMs: 0, tokens: { total: 20 }, cost: { apiEquivalentUsd: null } },
    { start: '2026-01-02', requests: 1, activeTimeMs: 0, tokens: { total: 30 }, cost: { apiEquivalentUsd: null } },
    { start: '2026-01-03', requests: 0, activeTimeMs: 0, tokens: { total: 0 }, cost: { apiEquivalentUsd: null } },
    { start: '2026-01-04', requests: 1, activeTimeMs: 0, tokens: { total: 40 }, cost: { apiEquivalentUsd: null } },
  ] } as UsageLedgerSeries;
  assert.equal(usageDays(series, '2026-01-01', '2026-01-05'), 3);
  assert.equal(usageDays(series, '2026-01-02', '2026-01-04'), 1);
  assert.equal(usageDays(series, '2025-12-31', '2026-01-05'), undefined, 'partial calendar coverage must not claim a complete day count');
  assert.equal(usageDays({ ...series, granularity: 'week' }, '2026-01-01', '2026-01-05'), undefined);
});

test('unmeasured native durations do not claim zero aggregate activity', () => {
  assert.equal(aggregateActiveTime(0, 1702, 'en'), 'Not measured');
  assert.equal(aggregateActiveTime(0, 1702, 'zh-CN'), '无法测量');
  assert.equal(aggregateActiveTime(1, 1, 'en'), '≈ < 1 min');
  assert.equal(aggregateActiveTime(0, 0, 'en'), '≈ 0 min');
});

test('reviewed copy identifies incremental scans and provider-reported cost', () => {
  const en = usageCopy('en'), zh = usageCopy('zh-CN');
  assert.equal(en.tiles.reportedCost, 'reported by providers');
  assert.equal(en.sessions.importAction, 'Import');
  assert.equal(zh.sessions.importAction, '导入');
  assert.equal(zh.sessions.openChat, '打开对话');
  assert.equal(en.sources.total(0, 0), 'Latest scan: 0 files read · 0 usage records');
  assert.equal(en.sources.files(0, 1), 'Latest scan: 0 / 1 files read');
});

test('one-request sessions never claim zero minutes in either language', () => {
  assert.equal(sessionActiveTime(0, 1, 'en'), '< 1 min');
  assert.equal(sessionActiveTime(59_999, 1, 'zh-CN'), '不到 1 分钟');
  assert.equal(sessionActiveTime(60_000, 1, 'en'), '1 min');
  assert.equal(sessionActiveTime(0, 0, 'en'), '0 min');
});

test('Grok model attribution coverage has a localized Sources label', () => {
  const problem = problemCounts({ model_not_reported_per_request: 1 })[0]!;
  assert.equal(problem.label, 'model_not_reported_per_request');
  assert.equal(usageCopy('en').sources.problemLabels[problem.label!], 'request without a reported model');
  assert.equal(usageCopy('zh-CN').sources.problemLabels[problem.label!], '请求未记录模型');
});

test('a single unsupported-format notice does not repeat its state in either language', () => {
  const problem = problemCounts({ not_supported_yet: 1 })[0]!;
  assert.equal(sourceProblemMatchesState(problem, 'unsupported'), true);
  assert.equal(sourceProblemMatchesState({ ...problem, count: 2 }, 'unsupported'), false);
  assert.equal(sourceProblemMatchesState(problem, 'found'), false);
});

test('heatmap details shift and flip within data bounds, clear of controls', () => {
  const bounds = { left: 24, top: 16, width: 540, height: 140 };
  for (const x of [24, 250, 564]) for (const y of [16, 80, 156]) {
    const tip = chartTipPosition(x, y, 480, 130, bounds);
    assert.ok(tip.left >= bounds.left && tip.left + 480 <= bounds.left + bounds.width);
    assert.ok(tip.top >= bounds.top && tip.top + 130 <= bounds.top + bounds.height);
  }
});

test('the inward-aligned last date reserves its actual text width', () => {
  const candidates = [{ index: 0, label: 'Sep 26' }, { index: 26, label: 'Oct 22' }, { index: 29, label: 'Oct 25' }];
  const pitch = 40, width = 100;
  const ticks = thinLabels(candidates, pitch, () => width);
  const rect = (tick: typeof ticks[number]) => {
    const center = tick.index * pitch + pitch / 2;
    const left = tick.align === 'start' ? tick.index * pitch : tick.align === 'end' ? (tick.index + 1) * pitch - width : center - width / 2;
    return { left, right: left + width };
  };
  for (let i = 1; i < ticks.length; i++) assert.ok(rect(ticks[i]!).left >= rect(ticks[i - 1]!).right + 8);
});
