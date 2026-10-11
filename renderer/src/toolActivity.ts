import type { ChatItem, ChatPart } from '@threadterm/protocol';
import { delegationTool } from './delegation';
import { isSubagentPart, subagentItemsOf } from './subagentActivity';

export interface ToolActivityEntry { id: string; itemId: string; part: ChatPart }
export type ToolPresentation =
  | { type: 'item'; id: string; item: ChatItem }
  | { type: 'tools'; id: string; tools: ToolActivityEntry[] };
export type ToolStatus = 'running' | 'complete' | 'failed' | 'cancelled' | 'unknown';
export type ToolKind = 'command' | 'browser' | 'file' | 'search' | 'delegation' | 'mcp' | 'tool';
type Copy = (en: string, zh: string) => string;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const compact = (value: string | undefined): string | undefined => value?.replace(/\s+/g, ' ').slice(0, 160);
const hiddenSubagentTool = (part: ChatPart): boolean => part.toolName === 'subAgentActivity' || part.toolName === 'collabAgentToolCall';

/** Native question calls have a dedicated answer card, so the transport row is redundant. */
export function hiddenQuestionTool(part: ChatPart): boolean {
  const data = record(part.data);
  const xaiTool = record(record(data._meta)['x.ai/tool']);
  const questionName = (value: unknown): boolean => {
    const normalized = string(value)?.toLowerCase().replace(/[\s_-]/g, '');
    return normalized === 'askuser' || normalized === 'askuserquestion' || normalized === 'askinguserquestions' || normalized === 'question';
  };
  return questionName(part.toolName) || questionName(data.title) || questionName(xaiTool.name) || questionName(xaiTool.label)
    || string(xaiTool.kind) === 'ask_user';
}

const hiddenTool = (part: ChatPart): boolean => hiddenSubagentTool(part) || hiddenQuestionTool(part);

export function toolActivityWaitingLabel(awaitingQuestion: boolean, awaitingApproval: boolean, copy: Copy): string | undefined {
  if (awaitingQuestion) return copy('Waiting for your answer', '等待你的回答');
  if (awaitingApproval) return copy('Waiting for approval', '等待批准');
  return undefined;
}

function toolEntry(item: ChatItem, part: ChatPart, index: number): ToolActivityEntry {
  return { id: `${item.id}:${part.toolId ? `tool:${part.toolId}` : `part:${index}`}`, itemId: item.id, part };
}

export function toolEntriesForItems(items: readonly ChatItem[]): ToolActivityEntry[] {
  const entries: ToolActivityEntry[] = [];
  const ids = new Set<string>();
  for (const item of items) {
    if (item.role === 'user' || item.role === 'system') continue;
    item.parts.forEach((part, index) => {
      if (part.type !== 'tool' || hiddenTool(part)) return;
      const entry = toolEntry(item, part, index);
      if (ids.has(entry.id)) entry.id += `:${index}`;
      ids.add(entry.id);
      entries.push(entry);
    });
  }
  return entries;
}

export function withoutToolParts(items: readonly ChatItem[]): ChatItem[] {
  return items.flatMap(item => {
    if (item.role === 'user' || item.role === 'system') return [item];
    const parts = item.parts.filter(part => part.type !== 'tool');
    return parts.length ? [{ ...item, parts }] : [];
  });
}

/** Completed interactions belong before the final reply, even if an adapter updated an older text row late. */
export function orderCompletedTurnItems(items: readonly ChatItem[]): ChatItem[] {
  let finalIndex = -1;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.role === 'assistant' && item.parts.some(part => part.type === 'text' && part.text)) { finalIndex = index; break; }
  }
  if (finalIndex < 0) return [...items];
  const final = items[finalIndex]!;
  const late = items.slice(finalIndex + 1);
  const interactions = late.filter(item => item.parts.some(part => part.type === 'approval'));
  const remainder = late.filter(item => !item.parts.some(part => part.type === 'approval'));
  const approvals = final.parts.filter(part => part.type === 'approval');
  if (!approvals.length && !interactions.length) return [...items];
  const orderedFinal = approvals.length ? { ...final, parts: [...approvals, ...final.parts.filter(part => part.type !== 'approval')] } : final;
  return [...items.slice(0, finalIndex), ...interactions, orderedFinal, ...remainder];
}

/** Activity cards precede the response; response cards keep their native position. */
export function completedTurnPresentation(activityItems: readonly ChatItem[], responseItems: readonly ChatItem[]): { activity: ChatItem[]; subagents: ChatItem[]; response: ChatItem[] } {
  const activity = withoutToolParts(activityItems).flatMap(item => {
    const parts = item.parts.filter(part => !isSubagentPart(part));
    return parts.length ? [{ ...item, parts }] : [];
  });
  return { activity, subagents: subagentItemsOf(activityItems), response: orderCompletedTurnItems(withoutToolParts(responseItems)) };
}

/** One chronological tool list; classification never changes grouping/order. */
export function groupToolActivity(items: readonly ChatItem[]): ToolPresentation[] {
  const result: ToolPresentation[] = [];
  let group: Extract<ToolPresentation, { type: 'tools' }> | undefined;
  let scope: string | undefined;
  let segment = 0;
  for (const item of items) {
    const boundary = item.role === 'user' || item.role === 'system' || item.parts.some(part => part.type === 'status');
    const currentScope = item.turnId || item.id;
    if (boundary || currentScope !== scope) { group = undefined; scope = currentScope; segment += 1; }
    if (item.role === 'user' || item.role === 'system') {
      result.push({ type: 'item', id: item.id, item });
      scope = undefined;
      continue;
    }
    let parts: ChatPart[] = [];
    let start = 0;
    const flush = () => {
      if (parts.length) {
        result.push({ type: 'item', id: `${item.id}:parts:${start}`, item: { ...item, parts } });
        parts = [];
      }
    };
    item.parts.forEach((part, index) => {
      if (part.type === 'tool' && hiddenTool(part)) return;
      if (part.type !== 'tool') {
        if (!parts.length) start = index;
        parts.push(part);
        return;
      }
      flush();
      if (!group) {
        group = { type: 'tools', id: `${currentScope}:tools:${segment}`, tools: [] };
        result.push(group);
      }
      const entry = toolEntry(item, part, index);
      if (group.tools.some(prior => prior.id === entry.id)) entry.id += `:${index}`;
      group.tools.push(entry);
    });
    flush();
    if (!item.parts.length) result.push({ type: 'item', id: item.id, item });
    if (boundary) scope = undefined;
  }
  return result;
}

export function toolStatus(part: ChatPart): ToolStatus {
  const data = record(part.data), state = record(data.state);
  const status = (part.status || string(state.status) || string(data.status) || '').toLowerCase().replace(/[\s_-]/g, '');
  if (['cancelled', 'canceled', 'interrupted', 'aborted'].includes(status)) return 'cancelled';
  if (['failed', 'error', 'declined', 'rejected'].includes(status)
    || data.isError === true || data.is_error === true
    || (typeof data.exitCode === 'number' && data.exitCode !== 0)) return 'failed';
  if (['running', 'pending', 'inprogress', 'streaming', 'executing'].includes(status)) return 'running';
  if (['complete', 'completed', 'success', 'succeeded'].includes(status)) return 'complete';
  return 'unknown';
}

function inputs(data: Record<string, unknown>): Record<string, unknown>[] {
  const values = [data.input, data.arguments, data.rawInput, data.args, record(data.state).input, data];
  return values.map(value => {
    if (typeof value === 'string') { try { return record(JSON.parse(value)); } catch { return {}; } }
    return record(value);
  });
}

const outputText = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(outputText);
  const item = record(value);
  const text = string(item.text);
  if (text) return [text];
  return item.content === undefined ? [] : outputText(item.content);
};

const ANSI = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const OUTPUT_PREVIEW_LIMIT = 240;

/** A compact real result line only; tool inputs are never serialized as output. */
export function toolOutputPreview(part: ChatPart): string | undefined {
  const data = record(part.data), state = record(data.state);
  const candidates = [
    record(data.result).content,
    record(data.partialResult).content,
    data.aggregatedOutput,
    data.output,
    data.rawOutput,
    data.content,
    state.output,
  ];
  for (const candidate of candidates) {
    const lines = outputText(candidate)
      .flatMap(text => text.replace(ANSI, '').replace(CONTROL, '').replace(/\r/g, '\n').split('\n'))
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const last = lines.at(-1);
    if (last) return last.length > OUTPUT_PREVIEW_LIMIT ? `${last.slice(0, OUTPUT_PREVIEW_LIMIT - 1)}…` : last;
  }
}

/**
 * Prefer the newest running call's own result. When it has none, the entry ID
 * identifies the most recent completed-result fallback in the same drawer.
 */
export function toolActivityPreview(entries: readonly ToolActivityEntry[], turnActive: boolean): { entryId: string; text: string } | undefined {
  const running = activeToolEntries(entries, turnActive);
  const current = running.at(-1);
  const currentText = current && toolOutputPreview(current.part);
  if (current && currentText) return { entryId: current.id, text: currentText };
  for (const entry of [...entries].reverse()) {
    const text = toolOutputPreview(entry.part);
    if (text) return { entryId: entry.id, text };
  }
}

export function describeTool(part: ChatPart, copy: Copy): { kind: ToolKind; name: string; action: string; detail?: string } {
  const data = record(part.data), delegation = delegationTool(part);
  const nativeName = string(data.tool) || string(part.toolName) || string(data.title) || copy('Tool', '工具');
  const leaf = nativeName.split('__').at(-1)!;
  const lower = leaf.toLowerCase();
  const server = string(data.server) || (/^mcp__(.+?)__/.exec(part.toolName ?? '')?.[1]);
  const args = inputs(data);
  const argument = (...keys: string[]) => {
    for (const input of args) for (const key of keys) { const value = string(input[key]); if (value) return compact(value); }
    return undefined;
  };
  if (delegation) {
    const names = {
      delegate_start: copy('Start delegate', '启动委派'), delegate_status: copy('Check delegates', '查看委派状态'),
      delegate_wait: copy('Wait for delegate', '等待委派'), delegate_respond: copy('Answer delegate', '答复委派请求'),
      delegate_result: copy('Read delegate result', '读取委派结果'), delegate_cancel: copy('Stop delegate', '停止委派'),
    };
    return { kind: 'delegation', name: names[delegation], action: copy('Delegating', '正在处理委派') };
  }
  if (/browser|playwright|puppeteer|selenium/.test(`${lower} ${server ?? ''}`)) {
    const operation = /navigate|goto|open/.test(lower) ? copy('Open page', '打开页面')
      : /snapshot/.test(lower) ? copy('Read page', '读取页面')
      : /screenshot/.test(lower) ? copy('Take screenshot', '截取页面')
      : /click/.test(lower) ? copy('Click element', '点击元素')
      : /fill|type/.test(lower) ? copy('Fill content', '填写内容') : leaf;
    let target = argument('url', 'selector', 'element');
    if (argument('url')) { try { const url = new URL(argument('url')!); target = url.host + url.pathname; } catch { /* Keep the native target. */ } }
    return { kind: 'browser', name: operation, action: copy('Browsing', '正在操作浏览器'), detail: target };
  }
  if (lower === 'commandexecution' || /\b(command|shell|bash|exec|execute|terminal)\b/.test(lower.replace(/[._-]+/g, ' ')) || data.kind === 'execute') {
    const actions = Array.isArray(data.commandActions) ? data.commandActions : [];
    const detail = compact(string(record(actions[0]).command)) || argument('command', 'cmd', 'script') || compact(string(data.rawInput));
    return { kind: 'command', name: copy('Command', '命令'), action: copy('Running command', '正在执行命令'), detail };
  }
  if (/search|web|grep|glob|fetch/.test(lower) || data.kind === 'search') {
    return { kind: 'search', name: copy('Search', '搜索'), action: copy('Searching', '正在搜索'), detail: argument('query', 'pattern', 'url') || leaf };
  }
  if (/file|patch|directory|read|write|edit/.test(lower) || ['read', 'edit', 'delete', 'move'].includes(String(data.kind))) {
    const patch = /patch|filechange/.test(lower), write = /write/.test(lower), edit = /edit/.test(lower) || data.kind === 'edit';
    const read = /read/.test(lower) || data.kind === 'read';
    const changes = Array.isArray(data.changes) ? data.changes : [];
    const path = compact(string(record(changes[0]).path));
    const detail = argument('file_path', 'filePath', 'path', 'filename') || (path ? `${path}${changes.length > 1 ? ` (+${changes.length - 1})` : ''}` : undefined) || compact(string(data.title)) || leaf;
    const action = patch ? copy('Applying changes', '正在修改文件') : write ? copy('Writing file', '正在写入文件')
      : edit ? copy('Editing file', '正在编辑文件') : read ? copy('Reading file', '正在读取文件') : copy('Accessing files', '正在处理文件');
    return { kind: 'file', name: copy('Files', '文件操作'), action, detail };
  }
  if (server || /^mcp(?:__|toolcall)/i.test(part.toolName ?? '')) {
    return { kind: 'mcp', name: leaf, action: copy('Calling MCP', '正在调用 MCP'), detail: server };
  }
  return { kind: 'tool', name: leaf, action: copy('Running tool', '正在执行工具'), detail: compact(string(data.title)) };
}

export function activeToolEntries(entries: readonly ToolActivityEntry[], turnActive: boolean): ToolActivityEntry[] {
  return turnActive ? entries.filter(entry => toolStatus(entry.part) === 'running') : [];
}
