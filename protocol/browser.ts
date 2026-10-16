/** Private runtime/main browser channel. These methods are never exposed by preload. */
export type BrowserDesktopMethod = 'browser.attach' | 'browser.registerTab' | 'browser.unregisterTab' | 'browser.detach' | 'browser.desktop.reply';
export type BrowserReadTool = 'browser_list_tabs' | 'browser_snapshot' | 'browser_screenshot' | 'browser_console_messages';
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
  tool: BrowserReadTool;
  arguments: Record<string, unknown>;
  targets: BrowserRegistration[];
}
export interface BrowserCancellation extends BrowserAttachment { operationId: string; workerGeneration: string; reason: string }
export type BrowserPrivateFrame = { method: 'browser.execute'; params: BrowserExecution } | { method: 'browser.cancel'; params: BrowserCancellation };
export type BrowserMcpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' };
export interface BrowserMcpResult { content: BrowserMcpContent[]; isError?: boolean }
export interface BrowserTabSummary { tabId: string; title: string; url: string; origin: string; shareLevel: 'read' }
export interface BrowserTabListResult { tabs: BrowserTabSummary[]; truncated: boolean }

const METHODS: readonly string[] = ['browser.attach', 'browser.registerTab', 'browser.unregisterTab', 'browser.detach', 'browser.desktop.reply'];
const TOOLS: readonly string[] = ['browser_list_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console_messages'];
const LEVELS: readonly string[] = ['error', 'warning', 'info', 'debug', 'log'];
const ATTACHMENT_KEYS = ['attachmentId', 'attachmentGeneration', 'runtimeEpoch', 'viewGeneration'];
const REGISTRATION_KEYS = [...ATTACHMENT_KEYS, 'tabId', 'sourceTabId'];
const OPERATION_KEYS = [...ATTACHMENT_KEYS, 'operationId', 'workerGeneration'];
const EXECUTION_KEYS = [...OPERATION_KEYS, 'invocationId', 'callerSessionId', 'deadlineUnixMs', 'tool', 'arguments', 'targets'];
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

export function isBrowserDesktopMethod(value: unknown): value is BrowserDesktopMethod { return typeof value === 'string' && METHODS.includes(value); }
export function isBrowserAttachment(value: unknown): value is BrowserAttachment { return exact(value, ATTACHMENT_KEYS) && attachment(value); }
export function isBrowserRegistration(value: unknown): value is BrowserRegistration {
  return exact(value, REGISTRATION_KEYS) && attachment(value) && text(value.tabId) && text(value.sourceTabId);
}
export function isBrowserToolArguments(tool: BrowserReadTool, value: unknown): value is Record<string, unknown> {
  if (tool === 'browser_list_tabs') return exact(value, []);
  return exact(value, ['tabId'], tool === 'browser_console_messages' ? ['level'] : []) && text(value.tabId)
    && (value.level === undefined || typeof value.level === 'string' && LEVELS.includes(value.level));
}
export function isBrowserPrivateFrame(value: unknown): value is BrowserPrivateFrame {
  if (!exact(value, ['method', 'params'])) return false;
  if (value.method === 'browser.cancel') return exact(value.params, [...OPERATION_KEYS, 'reason']) && operation(value.params) && text(value.params.reason, 1024);
  if (value.method !== 'browser.execute' || !exact(value.params, EXECUTION_KEYS) || !operation(value.params)) return false;
  const p = value.params;
  if (!text(p.invocationId, 128) || !text(p.callerSessionId) || !counter(p.deadlineUnixMs)
    || typeof p.tool !== 'string' || !TOOLS.includes(p.tool) || !isBrowserToolArguments(p.tool as BrowserReadTool, p.arguments)
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
export function isBrowserTabListResult(value: unknown): value is BrowserTabListResult {
  return exact(value, ['tabs', 'truncated']) && typeof value.truncated === 'boolean' && Array.isArray(value.tabs) && value.tabs.length <= 256
    && value.tabs.every(tab => exact(tab, ['tabId', 'title', 'url', 'origin', 'shareLevel']) && text(tab.tabId) && typeof tab.title === 'string'
      && bytes(tab.title) <= 512 && typeof tab.url === 'string' && bytes(tab.url) <= 8192 && text(tab.origin, 4096) && tab.shareLevel === 'read')
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
  else if (method === 'browser.desktop.reply') valid = exact(value, [...OPERATION_KEYS, 'result']) && operation(value)
    && (isBrowserMcpResult(value.result) || isBrowserTabListResult(value.result));
  if (!valid) throw new Error('Invalid private browser request');
}
export function validateBrowserDesktopResult(method: BrowserDesktopMethod, value: unknown): void {
  if (method === 'browser.attach' && isBrowserAttachment(value) || method === 'browser.registerTab' && isBrowserRegistration(value)) return;
  const key = method === 'browser.detach' ? 'detached' : method === 'browser.unregisterTab' ? 'unregistered' : method === 'browser.desktop.reply' ? 'accepted' : undefined;
  if (key && exact(value, [key]) && value[key] === true) return;
  throw new Error('Invalid private browser response');
}
