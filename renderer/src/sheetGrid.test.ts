import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cellAddress, cellKind, cellText, columnIndex, columnLabel, coversRange, inSelection, isRightAligned,
  normalizeSelection, parseSheetTarget, rangeForViewport, rangeToTsv, renderedColumns, scrollLeftForColumn, scrollTopForRow,
  sheetFileSize, sheetSizeText,
  selectionSize, visibleColumns, visibleRows,
  SHEET_COLUMN_WIDTH, SHEET_COLUMN_HEADER_HEIGHT, SHEET_ROW_HEIGHT, SHEET_ROW_HEADER_WIDTH,
} from './sheetGrid';

test('column letters follow spreadsheet counting, not base 26 digits', () => {
  assert.deepEqual([0, 1, 25, 26, 27, 51, 52, 701, 702, 16383].map(columnLabel),
    ['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA', 'XFD']);
  assert.equal(columnLabel(-1), '');
  assert.equal(columnIndex('C'), 2);
  assert.equal(columnIndex('aa'), 26);
  assert.equal(columnIndex('XFD'), 16383);
  assert.equal(columnIndex('1'), undefined);
  assert.equal(columnIndex('A1'), undefined);
  assert.equal(columnIndex(''), undefined);
});

test('A1 and row-number targets parse, with $ anchors and 1-based rows', () => {
  assert.deepEqual(parseSheetTarget('A1'), { row: 0, column: 0 });
  assert.deepEqual(parseSheetTarget('c5'), { row: 4, column: 2 });
  assert.deepEqual(parseSheetTarget(' $C$5 '), { row: 4, column: 2 });
  assert.deepEqual(parseSheetTarget('AA10'), { row: 9, column: 26 });
  assert.deepEqual(parseSheetTarget('12'), { row: 11, column: 0 });
  for (const text of ['', 'A0', '0', 'A', '1A', 'A1:B2', '-3', 'A1.5']) assert.equal(parseSheetTarget(text), undefined, text);
  assert.equal(cellAddress(4, 2), 'C5');
  assert.equal(cellAddress(99, 26), 'AA100');
});

test('the visible row and column ranges include overscan and stay inside the sheet', () => {
  const all = visibleRows({ scrollTop: 0, height: 240 }, 1000);
  assert.deepEqual(all, { start: 0, count: 23 }); // 11 visible + 12 overscan, clamped at the top
  const middle = visibleRows({ scrollTop: SHEET_COLUMN_HEADER_HEIGHT + 100 * SHEET_ROW_HEIGHT, height: 240 }, 1000);
  assert.equal(middle.start, 100 - 12);
  assert.ok(middle.count >= 10 + 12);
  const end = visibleRows({ scrollTop: SHEET_COLUMN_HEADER_HEIGHT + 999 * SHEET_ROW_HEIGHT, height: 240 }, 1000);
  assert.ok(end.start >= 960);
  assert.equal(end.start + end.count, 1000);
  assert.deepEqual(visibleRows({ scrollTop: 0, height: 240 }, 0), { start: 0, count: 0 });

  const columns = visibleColumns({ scrollLeft: 0, width: SHEET_COLUMN_WIDTH * 8 }, 100);
  assert.deepEqual(columns, { start: 0, count: 11 }); // 9 visible + 2 overscan
  const far = visibleColumns({ scrollLeft: SHEET_ROW_HEADER_WIDTH + 50 * SHEET_COLUMN_WIDTH, width: 400 }, 52);
  assert.equal(far.start, 49);
  assert.equal(far.start + far.count, 52);
  assert.deepEqual(visibleColumns({ scrollLeft: 0, width: 400 }, 0), { start: 0, count: 0 });
});

test('the wanted range is the viewport plus overscan and the resident window covers it', () => {
  const wanted = rangeForViewport({ scrollTop: 0, scrollLeft: 0, width: 800, height: 240 }, { rows: 500, columns: 20 });
  assert.deepEqual(wanted, { start: 0, count: 23, columnStart: 0, columnCount: 11 });
  assert.equal(coversRange(wanted, wanted), true);
  assert.equal(coversRange(undefined, wanted), false);
  assert.equal(coversRange({ ...wanted, count: wanted.count - 1 }, wanted), false);
  assert.equal(coversRange({ ...wanted, columnCount: wanted.columnCount - 1 }, wanted), false);
  assert.equal(coversRange({ start: 0, count: 100, columnStart: 0, columnCount: 20 }, wanted), true);
});

test('drawn columns never include the one hidden under the row-number gutter', () => {
  assert.deepEqual(renderedColumns({ scrollLeft: 0, width: 400 }, 100), { start: 0, count: 5 });
  // Scrolled to the middle of column 16: column 16 is not drawn at all, column 17 starts at the gutter.
  assert.deepEqual(renderedColumns({ scrollLeft: SHEET_ROW_HEADER_WIDTH + 16 * SHEET_COLUMN_WIDTH + 20, width: 400 }, 100), { start: 17, count: 5 });
  assert.deepEqual(renderedColumns({ scrollLeft: SHEET_ROW_HEADER_WIDTH + 16 * SHEET_COLUMN_WIDTH, width: 400 }, 100), { start: 17, count: 5 });
  assert.deepEqual(renderedColumns({ scrollLeft: 0, width: 400 }, 1), { start: 0, count: 1 });
  assert.deepEqual(renderedColumns({ scrollLeft: 0, width: 400 }, 0), { start: 0, count: 0 });
  assert.deepEqual(renderedColumns({ scrollLeft: 10_000 * SHEET_COLUMN_WIDTH, width: 400 }, 20), { start: 19, count: 1 });
});

test('go-to scroll offsets line up with the fixed row and column metrics', () => {
  assert.equal(scrollTopForRow(0), 0);
  assert.equal(scrollTopForRow(10), 10 * SHEET_ROW_HEIGHT);
  assert.equal(scrollTopForRow(-5), 0);
  assert.equal(scrollLeftForColumn(3), 3 * SHEET_COLUMN_WIDTH);
  assert.equal(scrollLeftForColumn(0), 0);
});

test('selections normalize in either direction and count their cells', () => {
  const selection = normalizeSelection({ row: 9, column: 3 }, { row: 2, column: 1 });
  assert.deepEqual(selection, { rowStart: 2, rowEnd: 9, columnStart: 1, columnEnd: 3 });
  assert.equal(selectionSize(selection), 8 * 3);
  assert.equal(inSelection(selection, 2, 1), true);
  assert.equal(inSelection(selection, 9, 3), true);
  assert.equal(inSelection(selection, 10, 3), false);
  assert.equal(inSelection(selection, 2, 0), false);
  assert.equal(selectionSize(normalizeSelection({ row: 4, column: 2 }, { row: 4, column: 2 })), 1);
});

test('cells keep their kind for alignment and text', () => {
  assert.equal(cellText(null), '');
  assert.equal(cellText(undefined), '');
  assert.equal(cellText('text'), 'text');
  assert.equal(cellText(['1,234', 'n']), '1,234');
  assert.equal(cellKind(['2020-01-01', 'd']), 'd');
  assert.equal(cellKind('text'), undefined);
  for (const kind of ['n', 'd', 'b'] as const) assert.equal(isRightAligned([`x`, kind]), true);
  assert.equal(isRightAligned(['#DIV/0!', 'e']), false);
  assert.equal(isRightAligned('text'), false);
  assert.equal(isRightAligned(null), false);
});

test('a copied block is tab separated, trimmed and one line per row', () => {
  assert.equal(rangeToTsv([
    ['a', ['1,234', 'n'], null],
    ['b', null, null],
    [null, null, null],
  ]), 'a\t1,234\nb\n');
  assert.equal(rangeToTsv([['one', 'two\ttabbed', 'line\nbreak']]), 'one\ttwo tabbed\tline break');
  assert.equal(rangeToTsv([]), '');
  assert.equal(rangeToTsv([['2020-01-02', 'TRUE']]), '2020-01-02\tTRUE');
});

test('the toolbar says rows and columns in words and never shows a small file as 0.00 MiB', () => {
  assert.equal(sheetSizeText(13, 6, false), '13 rows × 6 columns');
  assert.equal(sheetSizeText(1, 1, false), '1 row × 1 column');
  assert.equal(sheetSizeText(727044, 20, true), '727,044 行 × 20 列');
  assert.equal(sheetFileSize(512), '512 B');
  assert.equal(sheetFileSize(2780), '2.7 KiB');
  assert.equal(sheetFileSize(103688072), '98.88 MiB');
});
