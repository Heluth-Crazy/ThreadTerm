import type { ChatPart } from '@threadterm/protocol';
import { toolView, type ToolEditDiff, type ToolEditFile, type ToolStatus, type ToolView } from './toolView';
import { hasRedactedBrowserResult } from './browserToolActivity';
import { displayPath, pathIsWithinCanonicalScope } from './projectScope';

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

/** Only show a directory chip when it differs from the session's native path. */
export function commandDisplayCwd(cwd: string | undefined, sessionCwd: string | undefined): string | undefined {
  const normalize = (value: string | undefined): string => {
    const path = displayPath(value).replace(/\//g, '\\').replace(/\\+$/, '');
    return /^(?:[a-z]:|\\\\)/i.test(path) ? path.toLowerCase() : path;
  };
  return cwd && normalize(cwd) !== normalize(sessionCwd) ? cwd : undefined;
}

/** Targets live in the title; omit bodies with no remaining metadata or output. */
export function toolCardHasBody(view: ToolView, sessionCwd?: string): boolean {
  switch (view.kind) {
    case 'command': return Boolean(view.shell || commandDisplayCwd(view.cwd, sessionCwd) || view.background
      || view.exitCode !== undefined && view.exitCode !== 0 || view.actions?.length || view.output);
    case 'read': return view.offset !== undefined || view.limit !== undefined || view.pages !== undefined;
    case 'search': return Boolean(view.path || view.glob || view.matches !== undefined && view.files !== undefined
      || view.flags?.caseInsensitive || view.flags?.multiline || view.omitted);
    case 'web': return Boolean(view.result);
    default: return true;
  }
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

/** Small argument objects read better as lines than as expandable tree nodes. */
export function compactToolArguments(value: unknown): [string, string][] | undefined {
  const parsed = parsedJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const entries = Object.entries(parsed);
  if (entries.length > 8 || entries.some(([, item]) => item !== null && !['string', 'number', 'boolean'].includes(typeof item))) return undefined;
  return entries.map(([key, item]) => [key, typeof item === 'string' ? item : String(item)]);
}

/** Lift MCP text out of its transport envelope without mutating native output. */
export function mcpResultView(value: unknown): { text?: string; structuredContent?: unknown; isError: boolean } | undefined {
  const parsed = parsedJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const result = parsed as Record<string, unknown>;
  if (!Array.isArray(result.content)) return undefined;
  const blocks = result.content.flatMap(block => {
    if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') return [];
    let text = block.text;
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Plain text stays plain. */ }
    return [text];
  });
  return { ...(blocks.length ? { text: blocks.join('\n\n') } : {}), structuredContent: result.structuredContent, isError: result.isError === true };
}

/** Every run tool's one-line summary; nothing else is summarised this way. */
const RUN_TOOL_NAMES = new Set(['run_list', 'run_start', 'run_status', 'run_logs', 'run_stop', 'run_restart']);
const RUN_ACTIVE_STATES = new Set(['starting', 'running', 'idle', 'waiting']);
/** Stable run codes; the MCP host wraps a runtime error into `chat_tool_request_failed` with the code as its message. */
const RUN_ERROR_CODES = new Set([
  'run_declined', 'run_not_found', 'run_not_permitted', 'detected_entry_changed', 'detected_entry_not_found',
  'detected_command_too_long', 'detected_command_unprintable', 'tool_not_found', 'chat_turn_inactive',
]);

export type RunToolSummary =
  | { kind: 'launch'; name: string; existing: boolean }
  | { kind: 'stop'; name: string }
  | { kind: 'logs'; name: string; lines: number }
  | { kind: 'list'; entries: number; running: number }
  | { kind: 'status'; name: string; state: string; readiness?: string }
  | { kind: 'error'; code: string };

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  const parsed = typeof value === 'string' ? parsedJson(value) : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

const textField = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

/** The compact, one-line reading of a run tool's result. The raw result stays in the card below it. */
export function runToolSummary(tool: string | undefined, args: unknown, result: unknown): RunToolSummary | undefined {
  if (!tool || !RUN_TOOL_NAMES.has(tool)) return undefined;
  const view = mcpResultView(result);
  let payload = jsonRecord(view?.structuredContent) ?? jsonRecord(view?.text);
  // A provider can hand the whole envelope back as text inside a text block: unwrap one level.
  if (payload && view?.isError !== true && Array.isArray(payload.content) && payload.name === undefined && payload.error === undefined) {
    payload = jsonRecord(mcpResultView(payload)?.text) ?? payload;
  }
  payload ??= jsonRecord(args);
  if (view?.isError === true || payload?.isError === true) {
    const error = jsonRecord(payload?.error) ?? payload;
    const code = textField(error?.code) ?? '';
    const fromMessage = (textField(error?.message) ?? '').split(':')[0]?.trim() ?? '';
    return { kind: 'error', code: RUN_ERROR_CODES.has(fromMessage) ? fromMessage : code || fromMessage || 'run_failed' };
  }
  if (!payload) return undefined;
  const name = textField(payload.name);
  switch (tool) {
    case 'run_start':
    case 'run_restart':
      return name ? { kind: 'launch', name, existing: payload.existing === true } : undefined;
    case 'run_stop':
      return name ? { kind: 'stop', name } : undefined;
    case 'run_logs': {
      const text = textField(payload.text) ?? '';
      const lines = text === '' ? 0 : text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length;
      return name ? { kind: 'logs', name, lines } : undefined;
    }
    case 'run_list': {
      const entries = Array.isArray(payload.entries) ? payload.entries.length : undefined;
      const runs = Array.isArray(payload.runs) ? payload.runs.filter(run => RUN_ACTIVE_STATES.has(String(jsonRecord(run)?.state ?? ''))).length : undefined;
      return entries === undefined || runs === undefined ? undefined : { kind: 'list', entries, running: runs };
    }
    case 'run_status': {
      const state = textField(payload.state);
      return name && state ? { kind: 'status', name, state, readiness: textField(payload.readiness) } : undefined;
    }
    default: return undefined;
  }
}

/** The summary's bilingual one-liner. A known run error becomes short copy; any other keeps its code. */
export function runToolSummaryLabel(summary: RunToolSummary, copy: Copy): string {
  switch (summary.kind) {
    case 'launch': return summary.existing
      ? copy(`Already running ${summary.name}`, `已在运行 ${summary.name}`)
      : copy(`Started ${summary.name}`, `已启动 ${summary.name}`);
    case 'stop': return copy(`Stopped ${summary.name}`, `已停止 ${summary.name}`);
    case 'logs': return summary.lines === 1
      ? copy(`1 line of ${summary.name}`, `${summary.name} 的 1 行输出`)
      : copy(`${summary.lines} lines of ${summary.name}`, `${summary.name} 的 ${summary.lines} 行输出`);
    case 'list': return copy(`${summary.entries} ${summary.entries === 1 ? 'entry' : 'entries'}, ${summary.running} running`, `${summary.entries} 个条目，${summary.running} 个运行中`);
    case 'status': return `${summary.name}: ${runStatusText(summary.state, summary.readiness, copy)}`;
    case 'error':
      if (summary.code === 'run_declined') return copy('Run declined', '已拒绝运行');
      if (summary.code === 'run_not_found') return copy('Run not found', '未找到该运行');
      if (summary.code === 'run_not_permitted') return copy('Not permitted', '没有权限');
      if (summary.code === 'detected_command_unprintable') return copy('Unprintable command', '命令含不可见字符');
      return summary.code;
  }
}

/** The exact run tool name behind a provider-native identity (`mcp__threadterm__run_start`,
 * `threadterm__run_start` or a bare `run_start`), or undefined for any other tool. */
export function runToolName(...names: (string | undefined)[]): string | undefined {
  for (const name of names) {
    if (!name) continue;
    const tool = name.startsWith('mcp__threadterm__') ? name.slice('mcp__threadterm__'.length)
      : name.startsWith('threadterm__') ? name.slice('threadterm__'.length) : name;
    if (RUN_TOOL_NAMES.has(tool)) return tool;
  }
  return undefined;
}

/** One provider-native tool result as the MCP envelope `mcpResultView` understands. Claude keeps the
 * result in `data.content`, ACP/Grok in `data.rawOutput` (Grok sometimes under `Content.content`). */
function mcpEnvelope(value: unknown, isError = false, depth = 0): Record<string, unknown> | undefined {
  if (depth > 3 || value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const parsed = parsedJson(value);
    if (parsed === value) return { content: [{ type: 'text', text: value }], isError };
    return mcpEnvelope(parsed, isError, depth + 1) ?? { content: [{ type: 'text', text: value }], isError };
  }
  if (Array.isArray(value)) return { content: value, isError };
  const record = jsonRecord(value);
  if (!record) return undefined;
  if (typeof record.content === 'string') return { content: [{ type: 'text', text: record.content }], isError: record.isError === true || isError };
  if (Array.isArray(record.content)) return { content: record.content, isError: record.isError === true || isError };
  const inner = jsonRecord(record.Content) ?? jsonRecord(record.content);
  if (inner) return mcpEnvelope(inner.content ?? inner, isError || record.isError === true, depth + 1);
  return undefined;
}

/** The provider's own tool result, normalized for the run summary. */
export function nativeToolResult(part: Pick<ChatPart, 'toolName' | 'data'>, view: ToolView): unknown {
  if (view.kind === 'mcp' && view.result !== undefined) return view.result;
  const data = jsonRecord(part.data) ?? {};
  const isError = data.isError === true || data.is_error === true;
  const candidates = [
    jsonRecord(data.result)?.content, data.result, jsonRecord(data.partialResult)?.content,
    data.aggregatedOutput, data.output, data.rawOutput, data.content,
  ];
  for (const candidate of candidates) {
    const envelope = mcpEnvelope(candidate, isError);
    if (envelope) return envelope;
  }
  return undefined;
}

/** The MCP server a part's tool belongs to, when the part declares one. */
function partServer(part: Pick<ChatPart, 'toolName'>, data: Record<string, unknown> | undefined): string | undefined {
  const declared = textField(data?.server);
  if (declared) return declared;
  const name = part.toolName ?? '';
  if (name.startsWith('mcp__')) return name.slice('mcp__'.length).split('__')[0];
  if (name.startsWith('threadterm__')) return 'threadterm';
  return undefined;
}

/** A run tool's summary from a native tool part, exactly as the card renders it. Handles Claude's
 * `data.content`, ACP/Grok's `data.rawOutput` and Grok's `threadterm__<tool>` identity. */
export function runToolSummaryFromPart(part: ChatPart): RunToolSummary | undefined {
  if (hasRedactedBrowserResult(part)) return undefined;
  const data = jsonRecord(part.data);
  // A foreign MCP server with a lookalike tool name is never a ThreadTerm run tool.
  const server = partServer(part, data);
  if (server !== undefined && server !== 'threadterm') return undefined;
  const tool = runToolName(part.toolName, textField(data?.tool), textField(data?.name));
  if (!tool) return undefined;
  const view = toolView(part);
  return runToolSummary(tool, view.kind === 'mcp' || view.kind === 'generic' ? view.args : undefined, nativeToolResult(part, view));
}

function runStatusText(state: string, readiness: string | undefined, copy: Copy): string {
  const active = state === 'running' || state === 'idle' || state === 'waiting';
  if (state === 'starting' || (active && readiness === 'waiting')) return copy('Starting', '启动中');
  if (active && readiness === 'ready') return copy('Ready', '已就绪');
  if (active) return copy('Running', '运行中');
  if (state === 'error') return copy('Failed', '失败');
  if (state === 'interrupted') return copy('Interrupted', '已中断');
  return copy('Exited', '已退出');
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
