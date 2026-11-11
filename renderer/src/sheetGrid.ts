/** Pure geometry and addressing for the sheet grid (`design.md` §3.6, R11/R13/R14/R15).
 * The view keeps only what the viewport plus overscan needs; these functions decide what
 * that is, so the sizes and the A1 parsing are testable without a DOM. */

/** Fixed metrics: one row height and one column width for every cell, so rows and columns can be
 * absolutely positioned and the DOM stays small (R11). */
export const SHEET_ROW_HEIGHT = 24;
export const SHEET_COLUMN_WIDTH = 108;
export const SHEET_ROW_HEADER_WIDTH = 60;
export const SHEET_COLUMN_HEADER_HEIGHT = 26;
export const SHEET_OVERSCAN_ROWS = 12;
export const SHEET_OVERSCAN_COLUMNS = 2;

export type SheetCellAddress = { row: number; column: number };
export type SheetSelection = { rowStart: number; rowEnd: number; columnStart: number; columnEnd: number };
export type SheetViewport = { scrollTop: number; scrollLeft: number; width: number; height: number };
export type SheetRange = { start: number; count: number; columnStart: number; columnCount: number };

/** 0 → A, 25 → Z, 26 → AA (spreadsheet letters, not base-26 digits). */
export function columnLabel(column: number): string {
  if (!Number.isFinite(column) || column < 0) return '';
  let value = Math.floor(column) + 1;
  let label = '';
  while (value > 0) {
    const digit = (value - 1) % 26;
    label = String.fromCharCode(65 + digit) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

/** The reverse of `columnLabel`; undefined for anything that is not one or more letters. */
export function columnIndex(label: string): number | undefined {
  if (!/^[A-Za-z]{1,5}$/.test(label)) return undefined;
  let value = 0;
  for (const char of label.toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64);
  return value - 1;
}

export function cellAddress(row: number, column: number): string {
  return `${columnLabel(column)}${row + 1}`;
}

/** `A1`, `$C$5` or a bare row number (`12`), the two forms R14 accepts. Row numbers are 1-based. */
export function parseSheetTarget(text: string): SheetCellAddress | undefined {
  const value = text.trim();
  const cell = /^\$?([A-Za-z]{1,5})\$?([1-9]\d{0,8})$/.exec(value);
  if (cell) {
    const column = columnIndex(cell[1]);
    return column === undefined ? undefined : { row: Number(cell[2]) - 1, column };
  }
  const row = /^([1-9]\d{0,8})$/.exec(value);
  return row ? { row: Number(row[1]) - 1, column: 0 } : undefined;
}

const clamp = (value: number, max: number) => Math.max(0, Math.min(Math.floor(value), Math.max(0, max)));

/** Rows the viewport shows, plus `overscan` each way, clamped to the sheet. `count` is at least 1
 * while the sheet has rows, so the first window always asks for something. */
export function visibleRows(viewport: { scrollTop: number; height: number }, totalRows: number, overscan = SHEET_OVERSCAN_ROWS) {
  if (totalRows <= 0) return { start: 0, count: 0 };
  const first = Math.floor(Math.max(0, viewport.scrollTop - SHEET_COLUMN_HEADER_HEIGHT) / SHEET_ROW_HEIGHT);
  const visible = Math.max(1, Math.ceil(viewport.height / SHEET_ROW_HEIGHT) + 1);
  const start = clamp(first - overscan, totalRows - 1);
  const end = clamp(first + visible + overscan, totalRows);
  return { start, count: Math.max(1, end - start) };
}

/** The same for columns, whose header takes the leftmost `SHEET_ROW_HEADER_WIDTH` pixels.
 * A column hidden under the pinned row-number gutter is not drawn at all, so no sliver of a
 * covered column shows beside the gutter (Excel clips it too). */
export function visibleColumns(viewport: { scrollLeft: number; width: number }, totalColumns: number, overscan = SHEET_OVERSCAN_COLUMNS) {
  if (totalColumns <= 0) return { start: 0, count: 0 };
  const first = Math.max(0, Math.ceil(viewport.scrollLeft / SHEET_COLUMN_WIDTH));
  const visible = Math.max(1, Math.ceil(viewport.width / SHEET_COLUMN_WIDTH) + 1);
  const start = clamp(first - overscan, totalColumns - 1);
  const end = clamp(first + visible + overscan, totalColumns);
  return { start, count: Math.max(1, end - start) };
}

/** The columns actually drawn: no left overscan, so nothing peeks out from under the pinned
 * row-number gutter; one extra column covers a partially visible right edge. */
export function renderedColumns(viewport: { scrollLeft: number; width: number }, totalColumns: number) {
  if (totalColumns <= 0) return { start: 0, count: 0 };
  const first = Math.max(0, Math.ceil(viewport.scrollLeft / SHEET_COLUMN_WIDTH));
  if (first >= totalColumns) return { start: totalColumns - 1, count: 1 };
  const visible = Math.max(1, Math.ceil(viewport.width / SHEET_COLUMN_WIDTH) + 1);
  return { start: first, count: Math.min(visible, totalColumns - first) };
}

/** The rectangle to have resident for this viewport (rows × columns, both clamped). */
export function rangeForViewport(viewport: SheetViewport, totals: { rows: number; columns: number }): SheetRange {
  const rows = visibleRows(viewport, totals.rows);
  const columns = visibleColumns(viewport, totals.columns);
  return { start: rows.start, count: rows.count, columnStart: columns.start, columnCount: columns.count };
}

/** True when the resident window already covers every cell the viewport plus overscan needs. */
export function coversRange(resident: SheetRange | undefined, wanted: SheetRange): boolean {
  if (!resident) return false;
  return wanted.start >= resident.start
    && wanted.start + wanted.count <= resident.start + resident.count
    && wanted.columnStart >= resident.columnStart
    && wanted.columnStart + wanted.columnCount <= resident.columnStart + resident.columnCount;
}

/** Scroll offset that puts `row` at the top of the row area, just below the sticky column letters
 * and to the right of the sticky row numbers (R14 go-to). */
export function scrollTopForRow(row: number): number {
  return Math.max(0, Math.floor(row) * SHEET_ROW_HEIGHT);
}

export function scrollLeftForColumn(column: number): number {
  return Math.max(0, Math.floor(column) * SHEET_COLUMN_WIDTH);
}

/** An anchor and a focus point, in either order, become one inclusive rectangle. */
export function normalizeSelection(anchor: SheetCellAddress, focus: SheetCellAddress): SheetSelection {
  return {
    rowStart: Math.min(anchor.row, focus.row),
    rowEnd: Math.max(anchor.row, focus.row),
    columnStart: Math.min(anchor.column, focus.column),
    columnEnd: Math.max(anchor.column, focus.column),
  };
}

export const selectionSize = (selection: SheetSelection) =>
  (selection.rowEnd - selection.rowStart + 1) * (selection.columnEnd - selection.columnStart + 1);

export const inSelection = (selection: SheetSelection, row: number, column: number) =>
  row >= selection.rowStart && row <= selection.rowEnd && column >= selection.columnStart && column <= selection.columnEnd;

/** Cell text as the grid draws it: `null` is empty, a bare string is text, a tuple is
 * `[text, kind]` for a number, date, boolean or error (R13). */
export function cellText(cell: import('@threadterm/protocol').SheetCell | undefined): string {
  if (cell === null || cell === undefined) return '';
  return typeof cell === 'string' ? cell : cell[0];
}

export function cellKind(cell: import('@threadterm/protocol').SheetCell | undefined): 'n' | 'd' | 'b' | 'e' | undefined {
  return cell !== null && cell !== undefined && typeof cell !== 'string' ? cell[1] : undefined;
}

/** Right-aligned: numbers, dates and booleans (R13). Errors and text are left-aligned. */
export const isRightAligned = (cell: import('@threadterm/protocol').SheetCell | undefined) =>
  ['n', 'd', 'b'].includes(cellKind(cell) ?? '');

/** Tab-separated text for the clipboard: one line per row, tabs between cells, trailing
 * empty cells trimmed so a copied block does not trail tabs (R15). */
export function rangeToTsv(rows: readonly (readonly import('@threadterm/protocol').SheetCell[])[]): string {
  return rows
    .map(row => {
      const cells = [...row];
      while (cells.length && cellText(cells.at(-1)) === '') cells.pop();
      return cells.map(cellText).map(text => text.replace(/\t/g, ' ').replace(/\r?\n/g, ' ')).join('\t');
    })
    .join('\n');
}

/** The sheet's extent as plain words (R11). The core counts from A1, so a range that starts at
 * `C5` still reads as its real last row and column, never as "used range". */
export function sheetSizeText(rows: number, columns: number, zh: boolean): string {
  const r = rows.toLocaleString('en-US'), c = columns.toLocaleString('en-US');
  return zh ? `${r} 行 × ${c} 列` : `${r} ${rows === 1 ? 'row' : 'rows'} × ${c} ${columns === 1 ? 'column' : 'columns'}`;
}

/** The workbook's file size: bytes, KiB or MiB, so a small file never reads "0.00 MiB". */
export function sheetFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
