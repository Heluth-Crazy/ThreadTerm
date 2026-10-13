import type { ToolEditDiff, ToolEditFile, ToolStatus, ToolView } from './toolView';
import { pathIsWithinCanonicalScope } from './projectScope';

/**
 * Pure presentation helpers for the typed tool cards (B2/B3). Everything that
 * can be decided without the DOM lives here so the renderer unit suite can
 * assert the diff line counts, the JSON tree caps and the lazy body rule.
 *
 * The cards are a presentation layer over `toolView`; they never branch on a
 * provider name and never mutate the native part.
 */

/** Unified/old-new diff lines shown before "Show all". */
export const DIFF_COLLAPSE_LINES = 200;
/** Past this many diff lines the card only offers "Open diff". */
export const DIFF_OPEN_ONLY_LINES = 2_000;
/** Approval cards bound their expanded preview across every edited file. */
export const APPROVAL_PREVIEW_FILE_LIMIT = 12;
export const APPROVAL_PREVIEW_ROW_LIMIT = 1_200;
/** Command output lines rendered at most in one card. */
export const OUTPUT_MAX_LINES = 400;
/** Command output tail shown while the output is collapsed. */
export const OUTPUT_COLLAPSED_TAIL = 40;
/** JSON tree depth expanded before the user opens a node. */
export const JSON_BASE_DEPTH = 2;
/** JSON tree node cap before the raw view replaces the tree. */
export const JSON_NODE_LIMIT = 500;
const JSON_LEAF_LIMIT = 120;

export type DiffRowKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
export interface DiffRow { kind: DiffRowKind; text: string; oldLine?: number; newLine?: number }
export interface DiffStats { added: number; removed: number }
export interface DiffView { rows: DiffRow[]; visible: DiffRow[]; stats: DiffStats; collapsed: boolean; canShowAll: boolean; openOnly: boolean }

export interface OutputView { lines: string[]; total: number; omitted: number; expandable: boolean }

export type JsonValueKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
export interface JsonRow { path: string; depth: number; key?: string; preview: string; kind: JsonValueKind; expandable: boolean; expanded: boolean }
export interface JsonView { rows: JsonRow[]; nodes: number; truncated: boolean }

function splitLines(value: string | undefined): string[] {
  if (value === undefined || value === '') return [];
  const normalized = value.replace(/\r\n?/g, '\n');
  return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n');
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse a unified diff, tracking old and new line numbers for the gutter. */
function unifiedRows(unified: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine: number | undefined, newLine: number | undefined;
  for (const line of splitLines(unified)) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('\\') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) {
      rows.push({ kind: 'meta', text: line });
      continue;
    }
    if (line.startsWith('+')) { rows.push({ kind: 'add', text: line.slice(1), newLine }); newLine = newLine === undefined ? undefined : newLine + 1; continue; }
    if (line.startsWith('-')) { rows.push({ kind: 'del', text: line.slice(1), oldLine }); oldLine = oldLine === undefined ? undefined : oldLine + 1; continue; }
    const text = line.startsWith(' ') ? line.slice(1) : line;
    rows.push({ kind: 'ctx', text, oldLine, newLine });
    oldLine = oldLine === undefined ? undefined : oldLine + 1;
    newLine = newLine === undefined ? undefined : newLine + 1;
  }
  return rows;
}

/** Old text is removed, new text is added; each side keeps its own line numbers. */
function pairedRows(oldText: string | undefined, newText: string | undefined): DiffRow[] {
  const before = splitLines(oldText), after = splitLines(newText);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  const rows: DiffRow[] = [];
  for (let index = start; index < before.length - end; index += 1) rows.push({ kind: 'del', text: before[index]!, oldLine: index + 1 });
  for (let index = start; index < after.length - end; index += 1) rows.push({ kind: 'add', text: after[index]!, newLine: index + 1 });
  return rows;
}

export function diffStats(rows: readonly DiffRow[]): DiffStats {
  return {
    added: rows.filter(row => row.kind === 'add').length,
    removed: rows.filter(row => row.kind === 'del').length,
  };
}

/** Build the capped diff view for one file. */
export function diffView(diff?: ToolEditDiff): DiffView {
  const rows = diff?.unified !== undefined ? unifiedRows(diff.unified) : pairedRows(diff?.oldText, diff?.newText);
  const canShowAll = rows.length > DIFF_COLLAPSE_LINES && rows.length <= DIFF_OPEN_ONLY_LINES;
  const openOnly = rows.length > DIFF_OPEN_ONLY_LINES;
  return { rows, visible: rows.slice(0, DIFF_COLLAPSE_LINES), stats: diffStats(rows), collapsed: rows.length > DIFF_COLLAPSE_LINES, canShowAll, openOnly };
}

/** `+a` / `−d` counts for one edited file, using its diff when present. */
export function editFileStats(file: ToolEditFile): DiffStats {
  if (file.diff) return diffStats(diffView(file.diff).rows);
  return { added: 0, removed: 0 };
}

/** The extra file count shown as "+N more files". */
export function moreFilesLabel(shown: number, total: number): string | undefined {
  return total > shown ? `+${total - shown}` : undefined;
}

/** Allocate a bounded approval-preview DOM budget in file order. */
export function approvalPreviewBudget(files: readonly ToolEditFile[], expanded: boolean): { files: number; rows: number[]; omittedFiles: number; omittedRows: number } {
  const fileLimit = expanded ? APPROVAL_PREVIEW_FILE_LIMIT : 3;
  let remaining = APPROVAL_PREVIEW_ROW_LIMIT;
  const rows: number[] = [];
  for (const file of files.slice(0, fileLimit)) {
    const wanted = file.diff ? Math.min(diffView(file.diff).rows.length, expanded ? DIFF_OPEN_ONLY_LINES : DIFF_COLLAPSE_LINES) : 0;
    const allowed = Math.min(wanted, remaining);
    rows.push(allowed);
    remaining -= allowed;
  }
  const shownRows = rows.reduce((total, value) => total + value, 0);
  const totalRows = files.reduce((total, file) => total + (file.diff ? diffView(file.diff).rows.length : 0), 0);
  return { files: rows.length, rows, omittedFiles: Math.max(0, files.length - rows.length), omittedRows: Math.max(0, totalRows - shownRows) };
}

/**
 * "Open diff" is only offered for a path a working-tree diff can open: a
 * relative path is workspace-relative, and an absolute path must sit inside
 * the session's project/worktree root. An absolute path with no known root is
 * hidden rather than offering an action that can only fail.
 */
export function isOpenableDiffPath(path: string | undefined, root: string | undefined): boolean {
  const value = path?.trim();
  if (!value) return false;
  if (!/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value)) return true;
  return pathIsWithinCanonicalScope(value, root);
}

/** Command/web output tail with the 400-line cap and a Show output state. */
export function outputView(text: string | undefined, expanded: boolean): OutputView {
  const lines = splitLines(text);
  const total = lines.length;
  if (total <= OUTPUT_MAX_LINES) return { lines, total, omitted: 0, expandable: false };
  if (expanded) return { lines: lines.slice(-OUTPUT_MAX_LINES), total, omitted: total - OUTPUT_MAX_LINES, expandable: false };
  return { lines: lines.slice(-OUTPUT_COLLAPSED_TAIL), total, omitted: total - OUTPUT_COLLAPSED_TAIL, expandable: true };
}

function jsonKind(value: unknown): JsonValueKind {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'object': return 'object';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    default: return 'string';
  }
}

function leafPreview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const single = (text ?? '').replace(/\n/g, '\\n');
  return single.length > JSON_LEAF_LIMIT ? `${single.slice(0, JSON_LEAF_LIMIT - 1)}…` : single;
}

/**
 * Flatten args/result into tree rows. Depth `JSON_BASE_DEPTH` is always open;
 * deeper nodes stay collapsed until their path is in `expanded`. The walk
 * stops at `JSON_NODE_LIMIT` rows and reports `truncated`, which the card uses
 * to offer "Show raw" instead of an unbounded tree.
 */
export function jsonView(value: unknown, expanded: ReadonlySet<string> = new Set(), collapsed: ReadonlySet<string> = new Set()): JsonView {
  const rows: JsonRow[] = [];
  let nodes = 0, truncated = false;
  const walk = (current: unknown, path: string, depth: number, key: string | undefined): void => {
    if (nodes >= JSON_NODE_LIMIT) { truncated = true; return; }
    nodes += 1;
    const kind = jsonKind(current);
    const expandable = kind === 'object' || kind === 'array';
    const open = expandable && !collapsed.has(path) && (depth < JSON_BASE_DEPTH || expanded.has(path));
    const count = kind === 'array' ? (current as unknown[]).length : kind === 'object' ? Object.keys(current as object).length : 0;
    const preview = kind === 'array' ? `[${count}]` : kind === 'object' ? `{${count}}` : leafPreview(current);
    rows.push({ path, depth, key, preview, kind, expandable, expanded: open });
    if (!open) return;
    const entries: [string, unknown][] = kind === 'array'
      ? (current as unknown[]).map((item, index) => [String(index), item])
      : Object.entries(current as Record<string, unknown>);
    for (const [childKey, child] of entries) {
      if (nodes >= JSON_NODE_LIMIT) { truncated = true; return; }
      // Names that are valid identifiers (or array indices) keep the readable
      // `$.a.b` form; anything else is quoted and bracketed so keys that
      // themselves contain a dot cannot collide with a nested path.
      const childPath = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(childKey) || /^\d+$/.test(childKey) ? `${path}.${childKey}` : `${path}[${JSON.stringify(childKey)}]`;
      walk(child, childPath, depth + 1, childKey);
    }
  };
  walk(value, '$', 0, undefined);
  return { rows, nodes, truncated };
}

/** Card bodies are only built for an open drawer; a collapsed drawer renders headers only. */
export function cardBodyVisible(open: boolean): boolean {
  return open;
}

type Copy = (en: string, zh: string) => string;

/** Neutral titles, colored status only: the status chip is the single colored signal. */
export function toolStatusLabel(status: ToolStatus, active: boolean, awaitingApproval: boolean, copy: Copy): { key: string; label: string } {
  if (status === 'running' && awaitingApproval) return { key: 'awaiting', label: copy('Awaiting approval', '等待批准') };
  if (status === 'running') return active ? { key: 'running', label: copy('Running', '执行中') } : { key: 'inactive', label: copy('Inactive', '已结束') };
  if (status === 'complete') return { key: 'complete', label: copy('Completed', '已完成') };
  if (status === 'failed') return { key: 'failed', label: copy('Failed', '失败') };
  if (status === 'cancelled') return { key: 'cancelled', label: copy('Interrupted', '已中断') };
  return { key: 'recorded', label: copy('Recorded', '已记录') };
}
