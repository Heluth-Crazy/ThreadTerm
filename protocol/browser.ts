/** Private runtime/main browser channel. These methods are never exposed by preload. */
export type BrowserDesktopMethod = 'browser.attach' | 'browser.registerTab' | 'browser.unregisterTab' | 'browser.detach' | 'browser.desktop.dispatch' | 'browser.desktop.reply' | 'browser.desktop.evalPrepared' | 'browser.desktop.evalInvalidated';
export type BrowserReadTool = 'browser_list_tabs' | 'browser_snapshot' | 'browser_screenshot' | 'browser_console_messages';
export type BrowserActionTool = 'browser_navigate' | 'browser_click' | 'browser_type' | 'browser_hover' | 'browser_press_key' | 'browser_select_option';
export type BrowserTool = BrowserReadTool | BrowserActionTool;
export type BrowserShareLevel = 'off' | 'read' | 'control';
export type BrowserPageKey = 'Enter' | 'Tab' | 'Escape' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'PageUp' | 'PageDown' | 'Backspace' | 'Delete' | 'Space';
export const BROWSER_READ_TOOLS: readonly BrowserReadTool[] = ['browser_list_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console_messages'];
export const BROWSER_ACTION_TOOLS: readonly BrowserActionTool[] = ['browser_navigate', 'browser_click', 'browser_type', 'browser_hover', 'browser_press_key', 'browser_select_option'];
export const BROWSER_PAGE_KEYS: readonly BrowserPageKey[] = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete', 'Space'];
export type BrowserConsoleLevel = 'error' | 'warning' | 'info' | 'debug' | 'log';
export interface BrowserAttachment {
  attachmentId: string;
  attachmentGeneration: number;
  runtimeEpoch: string;
  viewGeneration: number;
}
export interface BrowserRegistration extends BrowserAttachment { tabId: string; sourceTabId: string }
export interface BrowserExecution extends BrowserAttachment {
  operationId: string;
  invocationId: string;
  callerSessionId: string;
  workerGeneration: string;
  deadlineUnixMs: number;
  tool: BrowserTool;
  arguments: Record<string, unknown>;
  targets: BrowserRegistration[];
}
export interface BrowserCancellation extends BrowserAttachment { operationId: string; workerGeneration: string; reason: string }
export interface BrowserEvalPreparation extends BrowserAttachment {
  operationId: string;
  workerGeneration: string;
  invocationId: string;
  callerSessionId: string;
  turnId: string;
  tabId: string;
  codeHash: string;
  codeByteLength: number;
  settingsGeneration: string;
  deadlineUnixMs: number;
  target: BrowserRegistration;
}
export interface BrowserEvalFence extends BrowserAttachment {
  operationId: string;
  workerGeneration: string;
  preparedId: string;
  tabId: string;
  codeHash: string;
  settingsGeneration: string;
  origin: string;
  documentGeneration: number;
  navigationEpoch: number;
  grantEpoch: number;
}
export interface BrowserEvalExecution extends BrowserEvalFence {
  invocationId: string;
  callerSessionId: string;
  turnId: string;
  approvalId: string;
  code: string;
  codeByteLength: number;
  deadlineUnixMs: number;
}
export type BrowserPrivateFrame = { method: 'browser.execute'; params: BrowserExecution }
  | { method: 'browser.cancel'; params: BrowserCancellation }
  | { method: 'browser.eval.prepare'; params: BrowserEvalPreparation }
  | { method: 'browser.eval.execute'; params: BrowserEvalExecution };
export type BrowserMcpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' };
export interface BrowserMcpResult { content: BrowserMcpContent[]; isError?: boolean }
export type BrowserActionOutcome = 'completed' | 'failed' | 'cancelled' | 'outcome_unknown';
export type BrowserActionError = 'browser_action_failed' | 'browser_cancelled' | 'browser_deadline' | 'browser_outcome_unknown' | 'browser_stale_ref' | 'browser_unavailable' | 'browser_control_required' | 'browser_user_interrupted' | 'browser_navigation_rejected';
export interface BrowserActionSource { title: string; url: string; origin: string }
export interface BrowserActionReceipt {
  outcome: BrowserActionOutcome;
  code?: BrowserActionError;
  source?: BrowserActionSource;
  navigation?: { admitted: boolean; sharingRevoked: boolean };
}
export type BrowserEvalScalar = { type: 'undefined' | 'null' } | { type: 'boolean'; value: boolean }
  | { type: 'number'; value: number } | { type: 'string'; value: string };
export type BrowserEvalError = BrowserActionError | 'browser_eval_disabled' | 'browser_eval_unavailable'
  | 'browser_eval_denied' | 'browser_eval_expired' | 'browser_eval_failed' | 'browser_eval_unsupported_result';
export interface BrowserEvalReceipt {
  outcome: BrowserActionOutcome;
  code?: BrowserEvalError;
  source?: BrowserActionSource;
  result?: BrowserEvalScalar;
}
export interface BrowserTabSummary { tabId: string; title: string; url: string; origin: string; shareLevel: Exclude<BrowserShareLevel, 'off'> }
export interface BrowserTabListResult { tabs: BrowserTabSummary[]; truncated: boolean }

const METHODS: readonly string[] = ['browser.attach', 'browser.registerTab', 'browser.unregisterTab', 'browser.detach', 'browser.desktop.dispatch', 'browser.desktop.reply', 'browser.desktop.evalPrepared', 'browser.desktop.evalInvalidated'];
const TOOLS: readonly string[] = [...BROWSER_READ_TOOLS, ...BROWSER_ACTION_TOOLS];
const LEVELS: readonly string[] = ['error', 'warning', 'info', 'debug', 'log'];
const ACTION_OUTCOMES: readonly string[] = ['completed', 'failed', 'cancelled', 'outcome_unknown'];
const ACTION_ERRORS: readonly string[] = ['browser_action_failed', 'browser_cancelled', 'browser_deadline', 'browser_outcome_unknown', 'browser_stale_ref', 'browser_unavailable', 'browser_control_required', 'browser_user_interrupted', 'browser_navigation_rejected'];
const ATTACHMENT_KEYS = ['attachmentId', 'attachmentGeneration', 'runtimeEpoch', 'viewGeneration'];
const REGISTRATION_KEYS = [...ATTACHMENT_KEYS, 'tabId', 'sourceTabId'];
const OPERATION_KEYS = [...ATTACHMENT_KEYS, 'operationId', 'workerGeneration'];
const EXECUTION_KEYS = [...OPERATION_KEYS, 'invocationId', 'callerSessionId', 'deadlineUnixMs', 'tool', 'arguments', 'targets'];
const EVAL_PREPARATION_KEYS = [...OPERATION_KEYS, 'invocationId', 'callerSessionId', 'turnId', 'tabId', 'codeHash', 'codeByteLength', 'settingsGeneration', 'deadlineUnixMs', 'target'];
const EVAL_FENCE_KEYS = [...OPERATION_KEYS, 'preparedId', 'tabId', 'codeHash', 'settingsGeneration', 'origin', 'documentGeneration', 'navigationEpoch', 'grantEpoch'];
const EVAL_EXECUTION_KEYS = [...EVAL_FENCE_KEYS, 'invocationId', 'callerSessionId', 'turnId', 'approvalId', 'code', 'codeByteLength', 'deadlineUnixMs'];
const EVAL_ERRORS: readonly string[] = [...ACTION_ERRORS, 'browser_eval_disabled', 'browser_eval_unavailable', 'browser_eval_denied', 'browser_eval_expired', 'browser_eval_failed', 'browser_eval_unsupported_result'];
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> => record(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const text = (value: unknown, limit = 256): value is string => typeof value === 'string' && value.length > 0
  && bytes(value) <= limit && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const attachment = (value: Record<string, unknown>) => text(value.attachmentId) && counter(value.attachmentGeneration)
  && text(value.runtimeEpoch) && counter(value.viewGeneration);
const operation = (value: Record<string, unknown>) => attachment(value) && text(value.operationId, 512) && text(value.workerGeneration);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const codeLength = (value: unknown): value is number => counter(value) && (value as number) >= 1 && (value as number) <= 16 * 1024;
const wellFormed = (value: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
const origin = (value: unknown): value is string => {
  if (!text(value, 4096)) return false;
  try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value; }
  catch { return false; }
};
const evalFence = (value: Record<string, unknown>) => operation(value) && text(value.preparedId) && text(value.tabId)
  && hash(value.codeHash) && text(value.settingsGeneration) && origin(value.origin)
  && counter(value.documentGeneration) && counter(value.navigationEpoch) && counter(value.grantEpoch);
const matchingTarget = (target: BrowserRegistration, value: Record<string, unknown>) => target.tabId === value.tabId
  && target.attachmentId === value.attachmentId && target.attachmentGeneration === value.attachmentGeneration
  && target.runtimeEpoch === value.runtimeEpoch && target.viewGeneration === value.viewGeneration;

/** Eval has a separate policy boundary and is never admitted as an ordinary tool. */
export function isBrowserEvalArguments(value: unknown): value is { tabId: string; code: string } {
  return exact(value, ['tabId', 'code']) && text(value.tabId) && typeof value.code === 'string'
    && codeLength(bytes(value.code)) && !value.code.includes('\u0000') && wellFormed(value.code);
}
export function isBrowserEvalScalar(value: unknown): value is BrowserEvalScalar {
  if (exact(value, ['type']) && (value.type === 'undefined' || value.type === 'null')) return true;
  if (!exact(value, ['type', 'value'])) return false;
  return value.type === 'boolean' && typeof value.value === 'boolean'
    || value.type === 'number' && typeof value.value === 'number' && Number.isFinite(value.value)
    || value.type === 'string' && typeof value.value === 'string' && wellFormed(value.value) && bytes(value.value) <= 16 * 1024;
}
export function isBrowserEvalReceipt(value: unknown): value is BrowserEvalReceipt {
  if (!exact(value, ['outcome'], ['code', 'source', 'result']) || typeof value.outcome !== 'string' || !ACTION_OUTCOMES.includes(value.outcome)) return false;
  if (value.code !== undefined && (typeof value.code !== 'string' || !EVAL_ERRORS.includes(value.code))) return false;
  if (value.source !== undefined && (!exact(value.source, ['title', 'url', 'origin']) || typeof value.source.title !== 'string'
    || bytes(value.source.title) > 512 || !text(value.source.url, 8192) || !origin(value.source.origin))) return false;
  if (value.source !== undefined) {
    try {
      const source = value.source as Record<string, unknown>;
      const url = new URL(source.url as string);
      if (!['http:', 'https:', 'blob:'].includes(url.protocol) || url.username || url.password || url.origin !== source.origin) return false;
    } catch { return false; }
  }
  if (bytes(JSON.stringify(value)) > 60 * 1024) return false;
  return value.outcome === 'completed' ? value.code === undefined && value.source !== undefined && isBrowserEvalScalar(value.result)
    : !Object.hasOwn(value, 'result');
}

export function isBrowserDesktopMethod(value: unknown): value is BrowserDesktopMethod { return typeof value === 'string' && METHODS.includes(value); }
export function isBrowserAttachment(value: unknown): value is BrowserAttachment { return exact(value, ATTACHMENT_KEYS) && attachment(value); }
export function isBrowserRegistration(value: unknown): value is BrowserRegistration {
  return exact(value, REGISTRATION_KEYS) && attachment(value) && text(value.tabId) && text(value.sourceTabId);
}
export function isBrowserReadTool(value: unknown): value is BrowserReadTool {
  return typeof value === 'string' && (BROWSER_READ_TOOLS as readonly string[]).includes(value);
}
export function isBrowserActionTool(value: unknown): value is BrowserActionTool {
  return typeof value === 'string' && (BROWSER_ACTION_TOOLS as readonly string[]).includes(value);
}
export function isBrowserToolArguments(tool: BrowserTool, value: unknown): value is Record<string, unknown> {
  if (tool === 'browser_list_tabs') return exact(value, []);
  if (isBrowserReadTool(tool)) return exact(value, ['tabId'], tool === 'browser_console_messages' ? ['level'] : []) && text(value.tabId)
    && (value.level === undefined || typeof value.level === 'string' && LEVELS.includes(value.level));
  if (!isBrowserActionTool(tool)) return false;
  if (tool === 'browser_navigate') {
    if (!exact(value, ['tabId', 'url']) || !text(value.tabId) || !text(value.url, 8192)) return false;
    try {
      const url = new URL(value.url);
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
    } catch { return false; }
  }
  const extra = tool === 'browser_type' ? ['text'] : tool === 'browser_press_key' ? ['key'] : tool === 'browser_select_option' ? ['values'] : [];
  if (!exact(value, ['tabId', 'ref', ...extra]) || !text(value.tabId) || !text(value.ref)) return false;
  if (tool === 'browser_type') return typeof value.text === 'string' && bytes(value.text) <= 16 * 1024 && !value.text.includes('\u0000');
  if (tool === 'browser_press_key') return typeof value.key === 'string' && (BROWSER_PAGE_KEYS as readonly string[]).includes(value.key);
  if (tool === 'browser_select_option') {
    if (!Array.isArray(value.values) || value.values.length > 100 || !value.values.every(item => typeof item === 'string' && !item.includes('\u0000'))) return false;
    return new Set(value.values).size === value.values.length && value.values.reduce((sum, item: string) => sum + bytes(item), 0) <= 16 * 1024;
  }
  return true;
}
export function isBrowserPrivateFrame(value: unknown): value is BrowserPrivateFrame {
  if (!exact(value, ['method', 'params'])) return false;
  if (value.method === 'browser.cancel') return exact(value.params, [...OPERATION_KEYS, 'reason']) && operation(value.params) && text(value.params.reason, 1024);
  if (value.method === 'browser.eval.prepare') {
    const p = value.params;
    return exact(p, EVAL_PREPARATION_KEYS) && operation(p) && text(p.invocationId, 128) && text(p.callerSessionId)
      && text(p.turnId) && text(p.tabId) && hash(p.codeHash) && codeLength(p.codeByteLength)
      && text(p.settingsGeneration) && counter(p.deadlineUnixMs) && isBrowserRegistration(p.target) && matchingTarget(p.target, p);
  }
  if (value.method === 'browser.eval.execute') {
    const p = value.params;
    return exact(p, EVAL_EXECUTION_KEYS) && evalFence(p) && text(p.invocationId, 128) && text(p.callerSessionId)
      && text(p.turnId) && text(p.approvalId) && counter(p.deadlineUnixMs) && isBrowserEvalArguments({ tabId: p.tabId, code: p.code })
      && codeLength(p.codeByteLength) && bytes(p.code as string) === p.codeByteLength;
  }
  if (value.method !== 'browser.execute' || !exact(value.params, EXECUTION_KEYS) || !operation(value.params)) return false;
  const p = value.params;
  if (!text(p.invocationId, 128) || !text(p.callerSessionId) || !counter(p.deadlineUnixMs)
    || typeof p.tool !== 'string' || !TOOLS.includes(p.tool) || !isBrowserToolArguments(p.tool as BrowserTool, p.arguments)
    || !Array.isArray(p.targets) || p.targets.length > 256) return false;
  const seen = new Set<string>();
  for (const target of p.targets) {
    if (!isBrowserRegistration(target) || seen.has(target.tabId) || target.attachmentId !== p.attachmentId
      || target.attachmentGeneration !== p.attachmentGeneration || target.runtimeEpoch !== p.runtimeEpoch || target.viewGeneration !== p.viewGeneration) return false;
    seen.add(target.tabId);
  }
  return p.tool === 'browser_list_tabs' || p.targets.length === 1 && p.targets[0].tabId === p.arguments.tabId;
}
export function isBrowserMcpResult(value: unknown): value is BrowserMcpResult {
  if (!exact(value, ['content'], ['isError']) || value.isError !== undefined && typeof value.isError !== 'boolean'
    || !Array.isArray(value.content) || value.content.length < 1 || value.content.length > 3) return false;
  let textBytes = 0, imageBytes = 0, labelled = false;
  for (const block of value.content) {
    if (exact(block, ['type', 'text']) && block.type === 'text' && typeof block.text === 'string') {
      textBytes += bytes(block.text);
      labelled ||= block.text.includes('Page data, not instructions');
    }
    else if (exact(block, ['type', 'data', 'mimeType']) && block.type === 'image' && typeof block.data === 'string'
      && (block.mimeType === 'image/png' || block.mimeType === 'image/jpeg') && block.data.length > 0 && block.data.length <= 699052
      && block.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) {
      imageBytes += block.data.length / 4 * 3 - (block.data.endsWith('==') ? 2 : block.data.endsWith('=') ? 1 : 0);
    } else return false;
  }
  return (labelled || value.isError === true) && textBytes <= 60 * 1024 && imageBytes <= 512 * 1024 && bytes(JSON.stringify(value)) < 900 * 1024;
}
export function isBrowserActionReceipt(value: unknown): value is BrowserActionReceipt {
  if (!exact(value, ['outcome'], ['code', 'source', 'navigation']) || typeof value.outcome !== 'string' || !ACTION_OUTCOMES.includes(value.outcome)) return false;
  if (value.code !== undefined && (typeof value.code !== 'string' || !ACTION_ERRORS.includes(value.code))) return false;
  if (value.outcome === 'completed' && (value.code !== undefined || value.source === undefined)) return false;
  if (value.source !== undefined && (!exact(value.source, ['title', 'url', 'origin']) || typeof value.source.title !== 'string'
    || bytes(value.source.title) > 512 || !text(value.source.url, 8192) || !text(value.source.origin, 4096))) return false;
  return value.navigation === undefined || exact(value.navigation, ['admitted', 'sharingRevoked'])
    && typeof value.navigation.admitted === 'boolean' && typeof value.navigation.sharingRevoked === 'boolean';
}
export function isBrowserTabListResult(value: unknown): value is BrowserTabListResult {
  return exact(value, ['tabs', 'truncated']) && typeof value.truncated === 'boolean' && Array.isArray(value.tabs) && value.tabs.length <= 256
    && value.tabs.every(tab => exact(tab, ['tabId', 'title', 'url', 'origin', 'shareLevel']) && text(tab.tabId) && typeof tab.title === 'string'
      && bytes(tab.title) <= 512 && typeof tab.url === 'string' && bytes(tab.url) <= 8192 && text(tab.origin, 4096) && (tab.shareLevel === 'read' || tab.shareLevel === 'control'))
    && bytes(JSON.stringify(value)) <= 60 * 1024;
}
export function validateBrowserDesktopRequest(method: unknown, value: unknown): asserts method is BrowserDesktopMethod {
  let valid = false;
  if (method === 'browser.attach') valid = exact(value, ['viewId', 'workspaceId', 'workspaceRevision', 'viewGeneration'])
    && text(value.viewId) && text(value.workspaceId) && counter(value.workspaceRevision) && counter(value.viewGeneration);
  else if (method === 'browser.registerTab') valid = exact(value, ['attachmentId', 'attachmentGeneration', 'sourceTabId', 'workspaceRevision'])
    && text(value.attachmentId) && counter(value.attachmentGeneration) && text(value.sourceTabId) && counter(value.workspaceRevision);
  else if (method === 'browser.detach' || method === 'browser.unregisterTab') valid = exact(value,
    method === 'browser.detach' ? ['attachmentId', 'attachmentGeneration'] : ['attachmentId', 'attachmentGeneration', 'tabId'])
    && text(value.attachmentId) && counter(value.attachmentGeneration) && (method !== 'browser.unregisterTab' || text(value.tabId));
  else if (method === 'browser.desktop.evalPrepared') valid = exact(value, EVAL_FENCE_KEYS) && evalFence(value);
  else if (method === 'browser.desktop.evalInvalidated') valid = exact(value, [...OPERATION_KEYS, 'preparedId', 'reason']) && operation(value)
    && text(value.preparedId) && typeof value.reason === 'string' && EVAL_ERRORS.includes(value.reason);
  else if (method === 'browser.desktop.dispatch') valid = exact(value, OPERATION_KEYS) && operation(value)
    || exact(value, [...EVAL_FENCE_KEYS, 'approvalId']) && evalFence(value) && text(value.approvalId);
  else if (method === 'browser.desktop.reply') valid = exact(value, [...OPERATION_KEYS, 'result']) && operation(value)
    && (isBrowserMcpResult(value.result) || isBrowserTabListResult(value.result) || isBrowserActionReceipt(value.result) || isBrowserEvalReceipt(value.result));
  if (!valid) throw new Error('Invalid private browser request');
}
export function validateBrowserDesktopResult(method: BrowserDesktopMethod, value: unknown): void {
  if (method === 'browser.attach' && isBrowserAttachment(value) || method === 'browser.registerTab' && isBrowserRegistration(value)) return;
  const key = method === 'browser.detach' ? 'detached' : method === 'browser.unregisterTab' ? 'unregistered'
    : method === 'browser.desktop.reply' || method === 'browser.desktop.dispatch' || method === 'browser.desktop.evalPrepared' || method === 'browser.desktop.evalInvalidated' ? 'accepted' : undefined;
  if (key && exact(value, [key]) && value[key] === true) return;
  throw new Error('Invalid private browser response');
}
