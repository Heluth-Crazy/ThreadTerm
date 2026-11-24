import type { ChatPart } from '@threadterm/protocol';
import { describeTool, toolOutputPreview } from './toolActivity';
import { editFileStats } from './toolCards';
import { toolView, type ToolCommandStep, type ToolEditFile, type ToolStatus, type ToolView } from './toolView';

type Copy = (en: string, zh: string) => string;

/** One visible line of a tool call in a fold: icon, a plain-language label, where it happened, and its numbers. */
export interface ToolRowLine {
  /** Stable within the call. */
  key: string;
  icon: string;
  label: string;
  /** The label is a shell command, shown in the monospace face. */
  mono?: boolean;
  /** Faint context after the label: the folder, the search scope, the server. */
  where?: string;
  added?: number;
  removed?: number;
  /** Faint right-side word: no matches, background, interrupted. */
  note?: string;
  /** An edit line's file, whose diff the expanded line shows. */
  file?: ToolEditFile;
}

export interface ToolRow {
  status: ToolStatus;
  lines: ToolRowLine[];
  /** Edited files past the line budget. */
  moreFiles: number;
  /** A failed command's non-zero exit code. */
  exitCode?: number;
  /** One line saying why a failed call failed, shown without opening it. */
  reason?: string;
  /** The present-tense headline while the call runs ("正在读取 api.ts"). */
  live: string;
}

/** Edits render one line per file up to this many; the rest is a count. */
export const ROW_FILE_LIMIT = 20;
const LABEL_NAMES = 2;

const slashes = (value: string): string => value.replace(/\\/g, '/');

/** A path relative to the session folder when it lies inside it; otherwise as given. */
export function relativeToolPath(path: string, sessionCwd?: string): string {
  const value = slashes(path.trim());
  const root = sessionCwd ? slashes(sessionCwd.trim()).replace(/\/+$/, '') : '';
  if (root && value.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return value.slice(root.length + 1);
  return value.replace(/^\.\//, '');
}

export function splitToolPath(path: string, sessionCwd?: string): { name: string; folder?: string } {
  const relative = relativeToolPath(path, sessionCwd);
  const index = relative.replace(/\/+$/, '').lastIndexOf('/');
  if (index < 0) return { name: relative };
  return { name: relative.slice(index + 1), folder: relative.slice(0, index) || '/' };
}

const nameList = (names: readonly string[], copy: Copy): string => {
  const shown = names.slice(0, LABEL_NAMES);
  const rest = names.length - shown.length;
  return rest > 0
    ? copy(`${shown.join(', ')} and ${rest} more`, `${shown.join('、')} 等 ${names.length} 个`)
    : copy(shown.join(', '), shown.join('、'));
};

const FAILURE_LINE = /\b(error|errors|fail|failed|failure|exception|fatal|panic|denied|not found|cannot|unable)\b|错误|失败/i;
const ANSI = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g;

/** The line that says why a call failed: the last line naming an error, else the last line of output. */
export function failureReason(part: ChatPart, view: ToolView): string | undefined {
  const output = view.kind === 'command' ? view.output : undefined;
  if (output) {
    const lines = output.replace(ANSI, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const line = [...lines].reverse().find(value => FAILURE_LINE.test(value)) ?? lines.at(-1);
    if (line) return line.length > 240 ? `${line.slice(0, 239)}…` : line;
  }
  return toolOutputPreview(part);
}

/** `path:line:` result lines of a finished rg/grep, or nothing when the output is another shape. */
function searchHits(output: string | undefined): number | undefined {
  if (!output) return undefined;
  const hits = output.split(/\r?\n/).filter(line => /^[^\s:][^:]*:\d+[:-]/.test(line)).length;
  return hits || undefined;
}

function stepNames(steps: readonly ToolCommandStep[], sessionCwd?: string): string[] {
  return [...new Set(steps.map(step => step.path ? splitToolPath(step.path, sessionCwd).name : step.name ?? '').filter(Boolean))];
}

function commonFolder(steps: readonly ToolCommandStep[], sessionCwd?: string): string | undefined {
  const folders = new Set(steps.map(step => step.path ? splitToolPath(step.path, sessionCwd).folder ?? '' : ''));
  return folders.size === 1 ? [...folders][0] || undefined : undefined;
}

function commandRow(part: ChatPart, view: Extract<ToolView, { kind: 'command' }>, copy: Copy, sessionCwd?: string): Omit<ToolRow, 'status' | 'moreFiles'> {
  const steps = view.steps ?? [];
  const kinds = new Set(steps.map(step => step.type));
  const note = view.noMatches ? copy('No matches', '无匹配') : view.background ? copy('Background', '后台') : undefined;
  const exitCode = view.exitCode !== undefined && view.exitCode !== 0 && !view.noMatches ? view.exitCode : undefined;
  // A command the provider parsed into reads, lists or searches only reads as what it did; anything else is the command.
  if (steps.length && kinds.size === 1 && !kinds.has('other')) {
    const kind = [...kinds][0]!;
    if (kind === 'search') {
      const queries = [...new Set(steps.map(step => step.query).filter((value): value is string => !!value))];
      const scope = steps.map(step => step.path ? relativeToolPath(step.path, sessionCwd) : '').find(Boolean);
      const hits = view.noMatches ? undefined : searchHits(view.output);
      const subject = queries.length ? nameList(queries, copy) : view.display;
      const where = [scope, hits ? copy(`${hits} ${hits === 1 ? 'hit' : 'hits'}`, `${hits} 处`) : undefined].filter(Boolean).join(' · ') || undefined;
      return { lines: [{ key: 'command', icon: 'search', label: copy(`Searched ${subject}`, `搜索 ${subject}`), where, note }],
        live: copy(`Searching ${subject}`, `正在搜索 ${subject}`), exitCode };
    }
    const names = stepNames(steps, sessionCwd);
    if (names.length) {
      const subject = nameList(names, copy);
      const folder = commonFolder(steps, sessionCwd);
      const read = kind === 'read';
      return { lines: [{ key: 'command', icon: read ? 'file' : 'folder', label: read ? copy(`Read ${subject}`, `读取 ${subject}`) : copy(`Listed ${subject}`, `列出 ${subject}`), where: folder, note }],
        live: read ? copy(`Reading ${subject}`, `正在读取 ${subject}`) : copy(`Listing ${subject}`, `正在列出 ${subject}`), exitCode };
    }
  }
  return { lines: [{ key: 'command', icon: 'terminal', label: view.display, mono: true, note }],
    live: copy(`Running ${view.display}`, `正在运行 ${view.display}`), exitCode };
}

function editVerb(file: ToolEditFile, copy: Copy): string {
  switch (file.change) {
    case 'add': return copy('Created', '新建');
    case 'delete': return copy('Deleted', '删除');
    case 'move': return copy('Moved', '移动');
    default: return copy('Edited', '修改');
  }
}

const editIcon = (file: ToolEditFile): string => file.change === 'add' ? 'plus' : file.change === 'delete' ? 'trash' : file.change === 'move' ? 'flow' : 'diff';

function editRow(view: Extract<ToolView, { kind: 'edit' }>, copy: Copy, sessionCwd?: string): Omit<ToolRow, 'status'> {
  const shown = view.files.slice(0, ROW_FILE_LIMIT);
  const lines = shown.map((file, index): ToolRowLine => {
    const { name, folder } = splitToolPath(file.path || copy('file', '文件'), sessionCwd);
    const target = file.movePath ? ` → ${splitToolPath(file.movePath, sessionCwd).name}` : '';
    const stats = editFileStats(file);
    return { key: `file:${index}`, icon: editIcon(file), label: `${editVerb(file, copy)} ${name}${target}`, where: folder,
      added: stats.added, removed: stats.removed, file };
  });
  const first = shown[0] ? splitToolPath(shown[0].path, sessionCwd).name : '';
  const subject = view.files.length > 1 ? copy(`${first} and ${view.files.length - 1} more`, `${first} 等 ${view.files.length} 个文件`) : first;
  return {
    lines: lines.length ? lines : [{ key: 'file:0', icon: 'diff', label: copy('Edited files', '修改文件') }],
    moreFiles: view.files.length - shown.length,
    live: subject ? copy(`Editing ${subject}`, `正在修改 ${subject}`) : copy('Editing files', '正在修改文件'),
  };
}

const host = (url: string): string => {
  try { const value = new URL(url); return `${value.host}${value.pathname === '/' ? '' : value.pathname}`; } catch { return url; }
};

/** How a tool call reads as one row of a fold (prototypes/chat-tool-rows, approved 11-23). */
export function toolRow(part: ChatPart, copy: Copy, sessionCwd?: string): ToolRow {
  const view = toolView(part);
  const status = view.status;
  const base = { status, moreFiles: 0 };
  const done = (row: Omit<ToolRow, 'status' | 'moreFiles'> & { moreFiles?: number }): ToolRow => {
    const failed = status === 'failed';
    return { ...base, ...row, ...(failed ? { reason: failureReason(part, view) } : {}) };
  };
  const described = describeTool(part, copy);
  if (described.kind === 'delegation' || described.kind === 'browser') {
    return done({ lines: [{ key: 'tool', icon: described.kind === 'delegation' ? 'agents' : 'globe', label: described.name, where: described.detail }],
      live: `${described.action}: ${described.detail || described.name}` });
  }
  switch (view.kind) {
    case 'command': return done(commandRow(part, view, copy, sessionCwd));
    case 'edit': return done(editRow(view, copy, sessionCwd));
    case 'read': {
      const { name, folder } = splitToolPath(view.path || view.title, sessionCwd);
      return done({ lines: [{ key: 'read', icon: 'file', label: copy(`Read ${name}`, `读取 ${name}`), where: folder }],
        live: copy(`Reading ${name}`, `正在读取 ${name}`) });
    }
    case 'search': {
      const scope = view.path ? relativeToolPath(view.path, sessionCwd) : view.glob;
      const hits = view.matches !== undefined ? copy(`${view.matches} ${view.matches === 1 ? 'hit' : 'hits'}`, `${view.matches} 处`) : undefined;
      return done({ lines: [{ key: 'search', icon: 'search', label: copy(`Searched ${view.query}`, `搜索 ${view.query}`), where: [scope, hits].filter(Boolean).join(' · ') || undefined }],
        live: copy(`Searching ${view.query}`, `正在搜索 ${view.query}`) });
    }
    case 'web': {
      const label = view.query ? copy(`Searched the web for ${view.query}`, `搜索网页 ${view.query}`)
        : view.url ? copy(`Opened ${host(view.url)}`, `打开 ${host(view.url)}`) : copy('Web', '网页');
      return done({ lines: [{ key: 'web', icon: 'globe', label }], live: view.query ? copy(`Searching the web for ${view.query}`, `正在搜索网页 ${view.query}`) : label });
    }
    case 'todo': return done({ lines: [{ key: 'todo', icon: 'check', label: copy(`Updated todos ${view.done}/${view.total}`, `更新待办 ${view.done}/${view.total}`) }],
      live: copy('Updating todos', '正在更新待办') });
    case 'skill': return done({ lines: [{ key: 'skill', icon: 'bolt', label: copy(`Used skill ${view.name}`, `使用技能 ${view.name}`) }],
      live: copy(`Using skill ${view.name}`, `正在使用技能 ${view.name}`) });
    case 'image': {
      const name = view.path ? splitToolPath(view.path, sessionCwd).name : '';
      const label = name ? copy(`Viewed ${name}`, `查看图片 ${name}`) : copy('Image', '图片');
      return done({ lines: [{ key: 'image', icon: 'image', label }], live: label });
    }
    case 'compaction': {
      const where = view.before !== undefined || view.after !== undefined ? `${(view.before ?? 0).toLocaleString()} → ${(view.after ?? 0).toLocaleString()}` : undefined;
      return done({ lines: [{ key: 'compaction', icon: 'layers', label: copy('Compacted context', '压缩上下文'), where }], live: copy('Compacting context', '正在压缩上下文') });
    }
    case 'mcp': return done({ lines: [{ key: 'mcp', icon: 'plug', label: view.tool, where: view.server }], live: `${described.action}: ${view.tool}` });
    case 'subagent': return done({ lines: [{ key: 'subagent', icon: 'agents', label: copy('Subagent', '子代理') }], live: copy('Running a subagent', '正在运行子代理') });
    case 'generic': return done({ lines: [{ key: 'tool', icon: 'wrench', label: view.name, where: described.detail }], live: `${described.action}: ${described.detail || view.name}` });
  }
}

/**
 * A thought's one-line title and the text an open row shows. Codex summaries open with a bold heading line
 * (`**Finding the save path**`), which becomes the title; other thoughts preview their first line without
 * Markdown markers and keep their whole text as the body.
 */
export function thoughtSummary(text: string | undefined): { title: string; body: string } {
  const value = (text ?? '').trim();
  const heading = /^\*\*([^*\r\n]+)\*\*[ \t]*(?:\r?\n|$)/.exec(value);
  if (heading) return { title: heading[1]!.trim(), body: value.slice(heading[0].length).trim() };
  const line = value.split(/\r?\n/).find(candidate => candidate.trim()) ?? '';
  const title = line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/, '')
    .replace(/`+|\*\*|__|~~/g, '')
    .trim();
  return { title, body: value };
}
