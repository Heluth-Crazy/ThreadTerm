import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, buildHeatmap, gridRow, heatLevel, quantileThresholds, resolveWeekStart, visibleMonthLabels, weekStartFor, weekdayOffset } from './usageHeatmap.js';

test('levels come from quantiles of the non-zero days, so one outlier cannot flatten the year', () => {
  const values = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 1_000_000];
  const thresholds = quantileThresholds(values);
  assert.equal(thresholds.length, 4);
  assert.equal(heatLevel(0, thresholds), 0);
  assert.equal(heatLevel(1, thresholds), 1);
  assert.equal(heatLevel(1_000_000, thresholds), 4);
});

test('the four quantile steps rise with the data', () => {
  assert.deepEqual(quantileThresholds([1, 2, 3, 4, 5]), [1.8, 2.6, 3.4, 4.2]);
  assert.deepEqual(quantileThresholds([0, 0]), []);
  assert.deepEqual(quantileThresholds([7, 7, 7]), [7]);
  assert.equal(heatLevel(0, []), 0);
  assert.equal(heatLevel(5, []), 0);
});

test('a uniform non-zero year stays on the first level', () => {
  const thresholds = quantileThresholds([4, 4, 4, 4]);
  assert.equal(heatLevel(4, thresholds), 1);
  assert.equal(heatLevel(0, thresholds), 0);
});

test('weeks start on the requested boundary and never shift the day', () => {
  // 2026-01-01 is a Thursday.
  assert.equal(weekdayOffset('2026-01-01', 'monday'), 3);
  assert.equal(weekdayOffset('2026-01-01', 'sunday'), 4);
  assert.equal(weekStartFor('2026-01-01', 'monday'), '2025-12-29');
  assert.equal(weekStartFor('2026-01-01', 'sunday'), '2025-12-28');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(resolveWeekStart('auto', 'zh-CN'), 'monday');
  assert.equal(resolveWeekStart('auto', 'en'), 'sunday');
  assert.equal(resolveWeekStart('sunday', 'zh-CN'), 'sunday');
  assert.equal(gridRow('2025-12-29', 'monday'), 1);
  assert.equal(gridRow('2025-12-28', 'sunday'), 1);
});

test('the grid pads the first and last weeks and keeps the last day in the last column', () => {
  const grid = buildHeatmap(new Map([['2026-01-02', 5]]), { from: '2026-01-01', to: '2026-01-14', weekStartsOn: 'monday' });
  assert.equal(grid.columns.length, 3);
  assert.deepEqual(grid.columns[0]!.slice(0, 3), [null, null, null]);
  assert.deepEqual(grid.columns[0]![3], { day: '2026-01-01', value: 0 });
  assert.deepEqual(grid.columns[0]![4], { day: '2026-01-02', value: 5 });
  assert.equal(grid.columns[2]!.filter(Boolean).length, 3);
  assert.equal(grid.columns[2]!.at(-1), null);
  assert.deepEqual(grid.columns[2]!.filter(Boolean).at(-1), { day: '2026-01-14', value: 0 });
});

test('month labels land on the column where a new month starts', () => {
  const grid = buildHeatmap(new Map(), { from: '2026-01-01', to: '2026-03-31', weekStartsOn: 'monday' });
  assert.deepEqual(grid.months.map(month => month.month), [0, 1, 2]);
  assert.equal(grid.months[0]!.column, 0);
  assert.ok(grid.months[1]!.column > 0);
});

test('month labels that would collide are dropped instead of overlapping', () => {
  const months = [{ column: 0, text: 'Oct' }, { column: 4, text: 'Nov' }, { column: 5, text: 'Dec' }, { column: 9, text: 'Jan' }];
  const order = (options: { pitch: number; width: number; columns?: number }) => visibleMonthLabels(months, {
    columns: options.columns ?? 53, pitch: options.pitch, widthOf: () => options.width,
  }).map(month => month.text);
  // 16 px cells leave room for every neighbour; 11 px cells cannot hold Dec one column after Nov (the "Oct Nov" bug).
  assert.deepEqual(order({ pitch: 30, width: 18 }), ['Oct', 'Nov', 'Dec', 'Jan']);
  assert.deepEqual(order({ pitch: 13, width: 18 }), ['Oct', 'Nov', 'Jan']);
  assert.ok(!order({ pitch: 13, width: 60 }).includes('Jan'));
  // Never place a label past the grid's right edge.
  assert.ok(!order({ pitch: 13, width: 18, columns: 5 }).includes('Jan'));
  assert.deepEqual(visibleMonthLabels([], { columns: 53, pitch: 13, widthOf: () => 18 }), []);
});

test('a partial first month is dropped only when it has fewer than three columns', () => {
  const grid = buildHeatmap(new Map(), { from: '2026-10-22', to: '2026-12-31', weekStartsOn: 'monday' });
  const labels = grid.months.map(month => ({ column: month.column, text: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month.month]! }));
  const shown = visibleMonthLabels(labels, { columns: grid.columns.length, pitch: 13, widthOf: () => 18 });
  assert.ok(!shown.some(month => month.text === 'Oct'), 'a two-column October is not labelled');
  assert.ok(shown.some(month => month.text === 'Nov'));
  const full = buildHeatmap(new Map(), { from: '2026-01-01', to: '2026-12-31', weekStartsOn: 'monday' }).months;
  const all = visibleMonthLabels(full.map(month => ({ column: month.column, text: 'Jan' })), { columns: 53, pitch: 13, widthOf: () => 18 });
  assert.equal(all[0]!.column, full[0]!.column);
});

test('a whole year fits in a GitHub-style grid', () => {
  const grid = buildHeatmap(new Map(), { from: '2025-10-25', to: '2026-10-24', weekStartsOn: 'sunday' });
  assert.ok(grid.columns.length >= 52 && grid.columns.length <= 54, `columns ${grid.columns.length}`);
  assert.ok(grid.columns.every(column => column.length === 7));
  assert.deepEqual(buildHeatmap(new Map(), { from: '2026-02-01', to: '2026-01-01', weekStartsOn: 'monday' }).columns, []);
});
