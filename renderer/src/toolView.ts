import type { ChatPart } from '@threadterm/protocol';

/**
 * One pure, total classifier that turns any provider's tool part into a typed
 * view. Detection uses the raw data shape only — never the provider name — and
 * malformed or unknown data falls back to `generic` without throwing.
 *
 * The cards (B2), the summary line (B3), approvals (D1) and export (F7) share
 * this view. `describeTool` in `toolActivity.ts` is an adapter over it.
 */

export type ToolStatus = 'running' | 'complete' | 'failed' | 'cancelled' | 'unknown';
export type ToolCommandAction = 'read' | 'search' | 'list';
export type ToolEditChange = 'add' | 'modify' | 'delete' | 'move';
export type ToolTodoStatus = 'pending' | 'in_progress' | 'completed';

export interface ToolEditDiff { unified?: string; oldText?: string; newText?: string }
export interface ToolEditFile { path: string; change: ToolEditChange; movePath?: string; diff?: ToolEditDiff; truncated?: boolean }
export interface ToolTodoItem { text: string; status: ToolTodoStatus }
export interface ToolSearchFlags { caseInsensitive?: boolean; multiline?: boolean }

interface ToolViewBase { status: ToolStatus; title: string }

export type ToolView =
  | (ToolViewBase & { kind: 'edit'; files: ToolEditFile[]; truncated?: boolean })
  | (ToolViewBase & { kind: 'command'; command: string; cwd?: string; output?: string; exitCode?: number; background?: boolean; actions?: ToolCommandAction[] })
  | (ToolViewBase & { kind: 'read'; path: string; offset?: number; limit?: number; pages?: number })
  | (ToolViewBase & { kind: 'search'; query: string; path?: string; glob?: string; flags?: ToolSearchFlags; matches?: number; files?: number; omitted?: boolean })
  | (ToolViewBase & { kind: 'web'; url?: string; query?: string; result?: string })
  | (ToolViewBase & { kind: 'todo'; items: ToolTodoItem[]; done: number; total: number })
  | (ToolViewBase & { kind: 'skill'; name: string; args?: string })
  | (ToolViewBase & { kind: 'subagent' })
  | (ToolViewBase & { kind: 'mcp'; server?: string; tool: string; args?: unknown; result?: unknown })
  | (ToolViewBase & { kind: 'image'; images: string[]; path?: string; imageStatus?: string })
  | (ToolViewBase & { kind: 'compaction'; before?: number; after?: number; trigger?: string })
  | (ToolViewBase & { kind: 'generic'; name: string; args?: unknown; result?: unknown });

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const compact = (value: string | undefined): string | undefined => value?.replace(/\s+/g, ' ').slice(0, 160);

/** Every native place a provider puts tool arguments, most specific first. */
export function toolInputs(data: Record<string, unknown>): Record<string, unknown>[] {
  const values = [data.input, data.arguments, data.rawInput, data.args, record(data.state).input, data];
  return values.map(value => {
    if (typeof value === 'string') { try { return record(JSON.parse(value)); } catch { return {}; } }
    return record(value);
  });
}

export function toolStatus(part: ChatPart): ToolStatus {
  const data = record(part?.data), state = record(data.state);
  const status = (part?.status || text(state.status) || text(data.status) || '').toLowerCase().replace(/[\s_-]/g, '');
  if (['cancelled', 'canceled', 'interrupted', 'aborted'].includes(status)) return 'cancelled';
  if (['failed', 'error', 'declined', 'rejected'].includes(status)
    || data.isError === true || data.is_error === true
    || (typeof data.exitCode === 'number' && data.exitCode !== 0)) return 'failed';
  if (['running', 'pending', 'inprogress', 'streaming', 'executing'].includes(status)) return 'running';
  if (['complete', 'completed', 'success', 'succeeded'].includes(status)) return 'complete';
  return 'unknown';
}

function outputText(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(outputText);
  const item = record(value);
  const body = text(item.text);
  if (body) return [body];
  return item.content === undefined ? [] : outputText(item.content);
}

function commandOutput(data: Record<string, unknown>): string | undefined {
  const state = record(data.state);
  const candidates = [record(data.result).content, record(data.partialResult).content, data.aggregatedOutput, data.output, data.rawOutput, data.content, state.output];
  const joined = candidates.flatMap(outputText).join('\n').trim();
  return joined || undefined;
}

function locationPaths(data: Record<string, unknown>): string[] {
  return array(data.locations).map(location => text(record(location).path)).filter((value): value is string => !!value);
}

function editFiles(data: Record<string, unknown>, arg: (...keys: string[]) => unknown, nativeName: string): { files: ToolEditFile[]; truncated?: boolean } {
  const lower = nativeName.toLowerCase();
  const changes = array(data.changes).map(record);
  if (changes.length) {
    return { files: changes.map(change => {
      const kind = record(change.kind);
      const type = text(kind.type) ?? 'update';
      const movePath = text(kind.move_path);
      const changeType: ToolEditChange = type === 'add' ? 'add' : type === 'delete' ? 'delete' : (type === 'move' || movePath) ? 'move' : 'modify';
      const unified = text(change.diff);
      return { path: text(change.path) ?? '', change: changeType, ...(movePath ? { movePath } : {}), ...(unified ? { diff: { unified } } : {}) };
    }) };
  }
  const diffs = array(data.content).map(record).filter(content => text(content.type) === 'diff');
  if (diffs.length) {
    return { files: diffs.map(content => {
      const oldText = text(content.oldText) ?? '';
      const newText = text(content.newText) ?? '';
      const change: ToolEditChange = oldText === '' && newText !== '' ? 'add' : newText === '' && oldText !== '' ? 'delete' : 'modify';
      return { path: text(content.path) ?? '', change, diff: { oldText, newText } };
    }) };
  }
  const kind = text(data.kind)?.toLowerCase();
  if (kind === 'move' || arg('source') !== undefined && arg('destination') !== undefined) {
    const source = text(arg('source')) ?? locationPaths(data)[0] ?? text(arg('path')) ?? '';
    const movePath = text(arg('destination')) ?? text(arg('move_path'));
    return { files: [{ path: source, change: 'move', ...(movePath ? { movePath } : {}) }] };
  }
  const path = text(arg('file_path', 'filePath', 'path', 'filename')) ?? locationPaths(data)[0] ?? '';
  const edits = array(arg('edits')).map(record);
  const oldString = text(arg('old_string', 'oldString'));
  const newString = text(arg('new_string', 'newString'));
  const unified = text(record(record(data.state).metadata).diff);
  let diff: ToolEditDiff | undefined;
  if (unified) diff = { unified };
  else if (oldString !== undefined || newString !== undefined) diff = { oldText: oldString ?? '', newText: newString ?? '' };
  else if (edits.length) diff = {
    oldText: edits.map(edit => text(edit.oldText) ?? text(edit.old_string) ?? '').join('\n'),
    newText: edits.map(edit => text(edit.newText) ?? text(edit.new_string) ?? '').join('\n'),
  };
  else {
    const content = text(arg('content'));
    if (content !== undefined) diff = { oldText: '', newText: content };
  }
  const write = /write|create/.test(lower) || (kind === 'edit' && oldString === '' && newString !== undefined);
  return { files: [{ path, change: write ? 'add' : 'modify', ...(diff ? { diff } : {}) }] };
}

function webLabel(url: string | undefined, query: string | undefined): string {
  if (url) { try { const parsed = new URL(url); return `${parsed.host}${parsed.pathname}`; } catch { return url; } }
  return query ? `Web search "${compact(query)}"` : 'Web';
}

function classify(part: ChatPart): ToolView {
  const data = record(part?.data);
  const status = toolStatus(part);
  const inputs = toolInputs(data);
  const arg = (...keys: string[]): unknown => {
    for (const input of inputs) for (const key of keys) if (input[key] !== undefined) return input[key];
    return undefined;
  };
  const argText = (...keys: string[]): string | undefined => text(arg(...keys));
  const nativeName = text(part?.toolName) ?? text(data.tool) ?? text(data.name) ?? text(data.title) ?? '';
  const leaf = nativeName.split('__').at(-1) || nativeName;
  const lower = leaf.toLowerCase();
  const nameLc = nativeName.toLowerCase();
  const meta = record(record(data._meta)['x.ai/tool']);
  const metaKind = text(meta.kind)?.toLowerCase();
  const metaName = text(meta.name)?.toLowerCase();
  const kindField = text(data.kind)?.toLowerCase();

  if (part?.type === 'subagent') {
    return { kind: 'subagent', status, title: text(data.description) ?? text(data.name) ?? 'Subagent' };
  }

  // MCP first: names like mcp__filesystem__read_file contain read/file words.
  const server = text(data.server) ?? (/^mcp__(.+?)__/.exec(part?.toolName ?? '')?.[1]);
  const mcpCall = data.type === 'mcpToolCall' || /^mcp(?:__|toolcall)/i.test(part?.toolName ?? '')
    || (text(data.server) !== undefined && text(data.tool) !== undefined);
  if (mcpCall) {
    const tool = text(data.tool) ?? (/^mcp__[^_]+__(.+)$/.exec(part?.toolName ?? '')?.[1]) ?? leaf;
    return { kind: 'mcp', status, title: server ? `${server}: ${tool}` : tool, server, tool, args: arg('arguments', 'input', 'rawInput', 'args'), result: data.result };
  }

  // Edit and write.
  const edits = array(arg('edits')).length;
  const contentDiffs = array(data.content).map(record).filter(content => text(content.type) === 'diff').length;
  const isEdit = data.type === 'fileChange'
    || ['edit', 'multiedit', 'write', 'patch', 'filechange', 'delete', 'move'].includes(kindField ?? '')
    || ['edit', 'multiedit', 'write', 'patch', 'filechange'].includes(nameLc)
    || metaKind === 'edit'
    || contentDiffs > 0
    || edits > 0
    || (text(arg('old_string', 'oldString')) !== undefined && text(arg('new_string', 'newString')) !== undefined);
  if (isEdit) {
    const result = editFiles(data, arg, nativeName);
    const first = result.files[0]?.path;
    const title = result.files.length > 1 ? `Edit (${result.files.length} files)` : `Edit ${first ?? leaf}`;
    return { kind: 'edit', status, title, files: result.files, ...(result.truncated ? { truncated: true } : {}) };
  }

  // Web before file search: a web search also carries a query.
  const isWeb = kindField === 'fetch' || nameLc.includes('web') || (metaName?.includes('web') ?? false)
    || (arg('url') !== undefined && !/read|file/.test(nameLc));
  if (isWeb) {
    const url = argText('url');
    const query = argText('query', 'prompt');
    return { kind: 'web', status, title: webLabel(url, query), url, query, result: compact(commandOutput(data)) };
  }

  // Command execution.
  const commandActions = array(data.commandActions).map(record);
  const isCommand = data.type === 'commandExecution'
    || kindField === 'execute' || metaKind === 'execute'
    || ['bash', 'execute', 'commandexecution', 'shell', 'terminal', 'run command', 'command'].includes(nameLc);
  if (isCommand) {
    const command = argText('command', 'cmd', 'script')
      ?? text(record(commandActions[0]).command)
      ?? (typeof data.rawInput === 'string' ? text(data.rawInput) : undefined)
      ?? leaf;
    const actions = commandActions.map(action => text(action.type) === 'listFiles' ? 'list' : text(action.type))
      .filter((value): value is ToolCommandAction => value === 'read' || value === 'search' || value === 'list');
    const exitCode = number(data.exitCode) ?? number(record(record(data.state).metadata).exit);
    const background = arg('run_in_background') === true || data.processId !== undefined || /background/.test(nameLc);
    return { kind: 'command', status, title: `Run ${compact(command)}`, command, cwd: text(data.cwd), output: commandOutput(data), exitCode,
      ...(background ? { background: true } : {}), ...(actions.length ? { actions: [...new Set(actions)] } : {}) };
  }

  // File search.
  const isSearch = kindField === 'search' || metaKind === 'search'
    || ['grep', 'glob', 'find', 'search'].includes(lower)
    || /(search|grep|glob|find)/.test(lower);
  if (isSearch) {
    const query = argText('pattern', 'query') ?? leaf;
    const flags: ToolSearchFlags = {};
    if (arg('-i') === true || arg('ignoreCase') === true || arg('caseInsensitive') === true) flags.caseInsensitive = true;
    if (arg('multiline') === true) flags.multiline = true;
    const output = commandOutput(data) ?? '';
    const counts = /(\d+)\s+matches? in (\d+) files?/i.exec(output);
    return { kind: 'search', status, title: `Grep "${compact(query)}"`, query, path: argText('path'), glob: argText('glob'),
      ...(Object.keys(flags).length ? { flags } : {}),
      ...(counts ? { matches: Number(counts[1]), files: Number(counts[2]) } : {}),
      ...(/not shown|omitted|truncated/i.test(output) ? { omitted: true } : {}) };
  }

  // Read, list and ls.
  const isRead = kindField === 'read' || metaKind === 'read'
    || ['read', 'ls', 'list'].includes(lower) || nameLc.startsWith('read ');
  if (isRead) {
    const path = argText('file_path', 'filePath', 'path', 'filename') ?? locationPaths(data)[0] ?? text(data.path) ?? leaf;
    return { kind: 'read', status, title: `Read ${path}`, path, offset: number(arg('offset')), limit: number(arg('limit')), pages: number(arg('pages')) };
  }

  // Todo list.
  const todos = array(arg('todos')).map(record);
  if (todos.length || nameLc === 'todowrite') {
    const items: ToolTodoItem[] = todos.map(todo => {
      const raw = text(todo.status)?.toLowerCase().replace(/[\s-]/g, '_');
      const state: ToolTodoStatus = raw === 'completed' ? 'completed' : raw === 'in_progress' ? 'in_progress' : 'pending';
      return { text: text(todo.content) ?? text(todo.text) ?? '', status: state };
    });
    const done = items.filter(item => item.status === 'completed').length;
    return { kind: 'todo', status, title: `Todos (${done}/${items.length})`, items, done, total: items.length };
  }

  // Skill.
  if (nameLc === 'skill' || arg('skill') !== undefined) {
    const skill = argText('skill') ?? leaf;
    return { kind: 'skill', status, title: `Skill ${skill}`, name: skill, args: argText('args') };
  }

  // Images.
  if (data.type === 'imageView' || data.type === 'imageGeneration' || nameLc.includes('image')) {
    const dataUrl = text(data.result);
    const images = dataUrl && (/^data:/.test(dataUrl) || /^https?:/.test(dataUrl)) ? [dataUrl] : [];
    return { kind: 'image', status, title: text(data.path) ? `Image ${text(data.path)}` : 'Image', images, path: text(data.path), imageStatus: text(data.status) };
  }

  // Context compaction.
  if (data.type === 'contextCompaction' || nameLc.includes('compact')) {
    return { kind: 'compaction', status, title: 'Compacted context', before: number(data.before), after: number(data.after), trigger: text(data.trigger) };
  }

  return { kind: 'generic', status, title: leaf || 'Tool', name: leaf || nativeName || 'Tool', args: arg('input', 'arguments', 'rawInput', 'args') ?? data, result: data.result ?? data.rawOutput };
}

const cache = new WeakMap<ChatPart, ToolView>();

export function toolView(part: ChatPart): ToolView {
  const key = part && typeof part === 'object' ? part : undefined;
  const cached = key ? cache.get(key) : undefined;
  if (cached) return cached;
  const view = classify(part);
  if (key) cache.set(key, view);
  return view;
}
