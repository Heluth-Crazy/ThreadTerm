import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ContextItem } from '../chatContext';
import type { FileCommentsHost } from '../fileCommentsHost';
import { request } from '../bridge';
import { externalFileErrorCode, externalSheetError } from '../externalFiles';
import { translate } from '../i18n';
import { officeSheetError } from '../workbench/errors';
import {
  SHEET_COLUMN_HEADER_HEIGHT, SHEET_COLUMN_WIDTH, SHEET_ROW_HEADER_WIDTH, SHEET_ROW_HEIGHT,
  cellAddress, cellText, columnLabel, coversRange, inSelection, isRightAligned, normalizeSelection,
  parseSheetTarget, rangeForViewport, rangeToTsv, renderedColumns, scrollLeftForColumn, scrollTopForRow, selectionSize,
  sheetFileSize, sheetSizeText,
  visibleRows, type SheetCellAddress, type SheetRange, type SheetSelection,
} from '../sheetGrid';
import {
  SHEET_COPY_MAX_CELLS, createSheetLoader, readSelection,
  type SheetTransport, type SheetViewerState,
} from '../sheetWindow';
import { ContextSendAction } from './ContextSendAction';
import { WbIcon } from '../workbench/icons';
import './sheet-view.css';

/** The first window: enough rows and columns for any normal viewport, so the second request only
 * happens when the view is larger or the user scrolls (`design.md` §3.6, R12). */
const FIRST_WINDOW: SheetRange = { start: 0, count: 60, columnStart: 0, columnCount: 24 };
/** R5: a tab hidden this long releases its helper; showing it again reloads without a click. */
const HIDDEN_RELEASE_MS = 5 * 60 * 1000;

/** Excel/ODS preview: dense sheet tabs (R10), a virtualized grid (R11), bounded windows (R12),
 * text-only cells (R13), go-to (R14) and copy (R15). Cells are drawn as text nodes; nothing here
 * follows a link or evaluates a formula. */
export function SheetView({ projectId, worktreePath, path, externalId, zh, active, comments, onExternalChange }: {
  projectId: string; worktreePath?: string; path: string; externalId?: string; zh: boolean;
  active?: boolean; comments?: FileCommentsHost;
  onExternalChange?: (file: { externalId: string; path: string }) => void;
}) {
  const t = (key: Parameters<typeof translate>[1]) => translate(zh ? 'zh-CN' : 'en', key);
  const grid = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<SheetViewerState>({
    sheet: 0, totalRows: 0, totalColumns: 0, loading: true, busy: true, changed: false,
  });
  const [viewport, setViewport] = useState({ scrollTop: 0, scrollLeft: 0, width: 0, height: 0 });
  const [cursor, setCursor] = useState<{ anchor: SheetCellAddress; focus: SheetCellAddress }>();
  const [detail, setDetail] = useState<{ address: string; text: string }>();
  const [goTo, setGoTo] = useState('');
  const [notice, setNotice] = useState<string>();
  const dragging = useRef(false);
  const wanted = useRef<SheetRange>(FIRST_WINDOW);
  const externalChange = useRef(onExternalChange);
  externalChange.current = onExternalChange;

  const transport = useMemo<SheetTransport>(() => ({
    open: async () => {
      if (!externalId) return request('filesystem.sheet.open', { projectId, worktreePath, path });
      try {
        return await request('filesystem.external.sheet.open', { id: externalId });
      } catch (error) {
        // A forgotten registration reopens once by its stored path, as the text viewer does.
        if (externalFileErrorCode(error) !== 'external_file_unknown') throw error;
        const reopened = await request('filesystem.external.open', { path, source: 'recent' });
        if (!('file' in reopened)) throw error;
        externalChange.current?.({ externalId: reopened.file.id, path: reopened.file.path });
        return request('filesystem.external.sheet.open', { id: reopened.file.id });
      }
    },
    rows: params => request('filesystem.sheet.rows', params),
    close: handle => request('filesystem.sheet.close', { handle }),
  }), [projectId, worktreePath, path, externalId]);
  const loader = useMemo(() => createSheetLoader(transport, setState), [transport]);

  useEffect(() => {
    void loader.load(wanted.current);
    // Unmount, a path change and Reload all end here: `filesystem.sheet.close` (R5).
    return () => loader.dispose();
  }, [loader]);

  const measure = useCallback(() => {
    const element = grid.current;
    if (!element) return;
    setViewport(current => {
      const next = { scrollTop: element.scrollTop, scrollLeft: element.scrollLeft, width: element.clientWidth, height: element.clientHeight };
      return current.scrollTop === next.scrollTop && current.scrollLeft === next.scrollLeft
        && current.width === next.width && current.height === next.height ? current : next;
    });
  }, []);
  useEffect(() => {
    const element = grid.current;
    if (!element) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const up = () => { dragging.current = false; };
    globalThis.addEventListener('mouseup', up);
    return () => { observer.disconnect(); globalThis.removeEventListener('mouseup', up); };
  }, [measure]);

  // One resident window: when the viewport leaves it, ask for a window that covers it again.
  useEffect(() => {
    if (!state.workbook || state.busy || state.changed || state.error !== undefined || state.totalRows <= 0) return;
    const next = rangeForViewport(viewport, { rows: state.totalRows, columns: state.totalColumns });
    if (coversRange(state.window, next)) return;
    wanted.current = next;
    void loader.load(next);
  }, [loader, state.workbook, state.busy, state.changed, state.error, state.totalRows, state.totalColumns, state.window, viewport]);

  const isActive = active !== false;
  const wasActive = useRef(isActive);
  useEffect(() => {
    if (isActive) return;
    const timer = setTimeout(() => void loader.release(), HIDDEN_RELEASE_MS);
    return () => clearTimeout(timer);
  }, [isActive, loader]);
  useEffect(() => {
    const resumed = isActive && !wasActive.current;
    wasActive.current = isActive;
    if (resumed && !state.workbook) void loader.load(wanted.current);
  }, [isActive, loader, state.workbook]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const cellAt = (row: number, column: number) => {
    const window = state.window;
    if (!window) return undefined;
    if (row < window.start || row >= window.start + window.count) return undefined;
    if (column < window.columnStart || column >= window.columnStart + window.columnCount) return undefined;
    return window.rows[row - window.start]?.[column - window.columnStart];
  };

  // The detail line keeps the last known text when the window moves away from the selected cell.
  useEffect(() => {
    if (!cursor) { setDetail(undefined); return; }
    const cell = cellAt(cursor.focus.row, cursor.focus.column);
    if (cell === undefined) return;
    setDetail({ address: cellAddress(cursor.focus.row, cursor.focus.column), text: cellText(cell) });
  }, [cursor, state.window]);

  const selection = cursor ? normalizeSelection(cursor.anchor, cursor.focus) : undefined;
  const selecting = (row: number, column: number, extend: boolean) => setCursor(current => ({
    anchor: extend && current ? current.anchor : { row, column },
    focus: { row, column },
  }));

  const errorText = (error: unknown) => externalId ? externalSheetError(error, zh) : officeSheetError(error, zh);

  const reveal = (row: number, column: number) => {
    const element = grid.current;
    if (!element) return;
    const top = SHEET_COLUMN_HEADER_HEIGHT + row * SHEET_ROW_HEIGHT;
    if (top < element.scrollTop + SHEET_COLUMN_HEADER_HEIGHT || top + SHEET_ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - SHEET_COLUMN_HEADER_HEIGHT);
    }
    const left = SHEET_ROW_HEADER_WIDTH + column * SHEET_COLUMN_WIDTH;
    if (left < element.scrollLeft + SHEET_ROW_HEADER_WIDTH || left + SHEET_COLUMN_WIDTH > element.scrollLeft + element.clientWidth) {
      element.scrollLeft = Math.max(0, left - SHEET_ROW_HEADER_WIDTH);
    }
    measure();
  };
  const jumpTo = (row: number, column: number) => {
    selecting(row, column, false);
    const element = grid.current;
    if (element) {
      element.scrollTop = scrollTopForRow(Math.max(0, row));
      element.scrollLeft = scrollLeftForColumn(Math.max(0, column));
      measure();
      element.focus();
    }
  };
  const goto = () => {
    const target = parseSheetTarget(goTo);
    if (!target) return;
    jumpTo(Math.min(target.row, Math.max(0, state.totalRows - 1)), Math.min(target.column, Math.max(0, state.totalColumns - 1)));
  };
  const chooseSheet = (index: number) => {
    setCursor(undefined);
    setDetail(undefined);
    const element = grid.current;
    if (element) { element.scrollTop = 0; element.scrollLeft = 0; }
    measure();
    void loader.selectSheet(index, FIRST_WINDOW);
  };

  /** The clipboard text of the selection: from the resident window when it holds every cell,
   * otherwise from windows fetched for the copy (R15), never more than 10,000 cells. */
  const selectionText = async (chosen: SheetSelection) => {
    if (selectionSize(chosen) > SHEET_COPY_MAX_CELLS) throw new Error('sheet_selection_too_large');
    const workbook = state.workbook;
    const window = state.window;
    const resident = window
      && coversRange(window, { start: chosen.rowStart, count: chosen.rowEnd - chosen.rowStart + 1, columnStart: chosen.columnStart, columnCount: chosen.columnEnd - chosen.columnStart + 1 });
    if (resident && window) {
      return rangeToTsv(window.rows
        .slice(chosen.rowStart - window.start, chosen.rowEnd - window.start + 1)
        .map(row => row.slice(chosen.columnStart - window.columnStart, chosen.columnEnd - window.columnStart + 1)));
    }
    if (!workbook) throw new Error('sheet_not_found');
    const read = await readSelection(transport, workbook.handle, state.sheet, chosen);
    if (read.tooLarge) throw new Error('sheet_selection_too_large');
    if (read.loading || !read.rows) throw new Error('sheet_not_ready');
    return rangeToTsv(read.rows);
  };
  const copy = async () => {
    if (!cursor) return;
    try {
      await navigator.clipboard.writeText(await selectionText(normalizeSelection(cursor.anchor, cursor.focus)));
      setNotice(t('sheetCopied'));
    } catch (error) {
      const text = String(error);
      setNotice(/sheet_selection_too_large/.test(text) ? t('sheetSelectionTooLarge') : /sheet_not_ready/.test(text) ? t('sheetLoading') : errorText(error));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'c' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void copy(); return; }
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const from = cursor?.focus ?? { row: 0, column: 0 };
    const row = Math.max(0, Math.min(state.totalRows - 1, from.row + move[0]));
    const column = Math.max(0, Math.min(state.totalColumns - 1, from.column + move[1]));
    selecting(row, column, event.shiftKey);
    reveal(row, column);
  };

  const sheet = state.workbook?.sheets[state.sheet];
  const ordered = (state.workbook?.sheets ?? []).map((info, index) => ({ info, index }))
    .sort((left, right) => Number(right.info.visible) - Number(left.info.visible) || left.index - right.index);
  const rowsView = visibleRows(viewport, state.totalRows);
  const columnsView = renderedColumns(viewport, state.totalColumns);
  const selectedText = detail?.text ?? '';
  const fileName = path.split(/[\\/]/).at(-1) ?? path;
  const progress = state.loading && typeof state.progress === 'number' && state.progress > 0
    ? `${Math.round(Math.min(1, state.progress) * 100)}%` : t('sheetLoading');
  const rows: ReactNode[] = [];
  for (let row = rowsView.start; row < rowsView.start + rowsView.count; row++) {
    const cells: ReactNode[] = [];
    for (let column = columnsView.start; column < columnsView.start + columnsView.count; column++) {
      const cell = cellAt(row, column);
      const text = cellText(cell);
      const chosen = Boolean(selection && inSelection(selection, row, column));
      const isCursor = cursor?.focus.row === row && cursor.focus.column === column;
      cells.push(<div key={column} data-row={row} data-column={column} className={`sheet-cell${isRightAligned(cell) ? ' is-numeric' : ''}${chosen ? ' is-selected' : ''}${isCursor ? ' is-cursor' : ''}`}
        style={{ left: SHEET_ROW_HEADER_WIDTH + column * SHEET_COLUMN_WIDTH, width: SHEET_COLUMN_WIDTH }}
        title={text.length > 14 ? text : undefined}
        onMouseDown={event => { if (event.button !== 0) return; event.preventDefault(); dragging.current = true; selecting(row, column, event.shiftKey); grid.current?.focus(); }}
        onMouseEnter={() => { if (dragging.current) selecting(row, column, true); }}><span className="sheet-cell-text">{text}</span></div>);
    }
    rows.push(<div className="sheet-row" key={row} style={{ top: SHEET_COLUMN_HEADER_HEIGHT + row * SHEET_ROW_HEIGHT, height: SHEET_ROW_HEIGHT }}>
      <div className="sheet-row-head" style={{ position: 'sticky', left: 0, width: SHEET_ROW_HEADER_WIDTH, height: SHEET_ROW_HEIGHT }}>{row + 1}</div>
      {cells}
    </div>);
  }

  return <section className="sheet-view" aria-label={t('sheetReadOnly')} aria-busy={state.busy}
    data-testid="sheet-view" data-file-path={path} data-sheet={state.sheet} data-sheet-name={sheet?.name}
    data-sheet-window-start={state.window?.start} data-total-rows={state.totalRows} data-total-columns={state.totalColumns}>
    {ordered.length > 1 && <div className="sheet-tabs" role="tablist" aria-label={t('sheetTabs')}>
      {ordered.map(({ info, index }) => <button key={`${index}:${info.name}`} type="button" role="tab" aria-selected={state.sheet === index}
        className={`sheet-tab${info.visible ? '' : ' is-hidden-sheet'}${state.sheet === index ? ' is-active' : ''}`}
        title={info.visible ? info.name : `${info.name} · ${t('sheetHiddenSheet')}`}
        data-testid="sheet-tab" data-sheet-index={index} data-sheet-visible={info.visible} onClick={() => chooseSheet(index)}>
        <span className="sheet-tab-name">{info.name}</span>
        {!info.visible && <span className="sheet-tab-hidden">{t('sheetHiddenTag')}</span>}
      </button>)}
    </div>}
    <div className="sheet-toolbar">
      {state.totalRows > 0 && <span className="sheet-meta" data-testid="sheet-used-range">{sheetSizeText(state.totalRows, state.totalColumns, zh)}</span>}
      {state.totalRows > 0 && state.workbook && <span className="sheet-meta" data-testid="sheet-file-size">{sheetFileSize(state.workbook.size)}</span>}
      <label className="sheet-goto" title={t('sheetGoTo')}>
        <input type="text" spellCheck={false} aria-label={t('sheetGoTo')} placeholder={t('sheetGoToPlaceholder')} data-testid="sheet-goto"
          value={goTo} onChange={event => setGoTo(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); goto(); } }} />
      </label>
      <button type="button" className="icon-btn icon-btn-sm" title={t('sheetCopy')} aria-label={t('sheetCopy')} data-testid="sheet-copy"
        disabled={!cursor} onClick={() => void copy()}><WbIcon name="copy" /></button>
      {selection && comments?.attachContext && <ContextSendAction host={comments} zh={zh} iconOnly testId="sheet-send-to-agent"
        item={async (): Promise<ContextItem> => ({
          kind: 'quote', id: crypto.randomUUID(),
          sourceTitle: `${fileName} · ${cellAddress(selection.rowStart, selection.columnStart)}:${cellAddress(selection.rowEnd, selection.columnEnd)}`,
          text: await selectionText(selection).catch(error => { throw error instanceof Error ? error : new Error(String(error)); }),
        })} />}
      <span className="grow" />
      {(state.loading || notice) && <span className="sheet-status" role="status" data-testid="sheet-status">{notice ?? progress}</span>}
    </div>
    {state.error !== undefined && <div className="tt-editor-state" role="alert" data-testid="sheet-error"><span>{errorText(state.error)}</span>
      <button type="button" className="btn btn-sm" data-testid="sheet-reload-error" onClick={() => void loader.reload()}>{t('sheetReload')}</button></div>}
    {state.changed && <div className="tt-editor-state" role="alert" data-testid="sheet-changed"><span>{t('sheetChanged')}</span>
      <button type="button" className="btn btn-sm" data-testid="sheet-reload-changed" onClick={() => void loader.reload()}>{t('sheetReload')}</button></div>}
    <div className="sheet-grid" ref={grid} tabIndex={0} role="grid" aria-label={t('sheetGrid')} aria-rowcount={state.totalRows}
      aria-colcount={state.totalColumns} data-testid="sheet-grid" onScroll={measure} onKeyDown={onKeyDown}>
      <div className="sheet-canvas" style={{ width: SHEET_ROW_HEADER_WIDTH + state.totalColumns * SHEET_COLUMN_WIDTH, height: SHEET_COLUMN_HEADER_HEIGHT + state.totalRows * SHEET_ROW_HEIGHT }}>
        <div className="sheet-col-head" style={{ height: SHEET_COLUMN_HEADER_HEIGHT }}>
          <div className="sheet-corner" style={{ position: 'sticky', left: 0, width: SHEET_ROW_HEADER_WIDTH, height: SHEET_COLUMN_HEADER_HEIGHT }} />
          {Array.from({ length: columnsView.count }, (_, offset) => columnsView.start + offset).map(column =>
            <div key={column} className="sheet-col-label" style={{ left: SHEET_ROW_HEADER_WIDTH + column * SHEET_COLUMN_WIDTH, width: SHEET_COLUMN_WIDTH }}>{columnLabel(column)}</div>)}
        </div>
        {rows}
      </div>
    </div>
    <div className="sheet-detail" data-testid="sheet-detail" aria-label={t('sheetDetail')} title={selectedText || undefined}>
      {detail && selectedText ? <><span className="sheet-detail-address">{detail.address}</span><span className="sheet-detail-text">{selectedText}</span></> : null}
    </div>
  </section>;
}
