type BrowserReadTool = 'browser_list_tabs' | 'browser_snapshot' | 'browser_screenshot' | 'browser_console_messages';

/** Bounded browser receipts contain provenance, never the private read body. */
export interface BrowserToolActivity {
  tool: string;
  outcome: 'running' | 'completed' | 'failed';
  tabId?: string;
  title?: string;
  url?: string;
  origin?: string;
  callerSessionId?: string;
  thumbnail?: string;
  provenanceUnavailable?: boolean;
}

const tools = new Set(['browser_list_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console_messages']);
const encoder = new TextEncoder();
const bounded = (value: unknown, bytes: number): string | undefined =>
  typeof value === 'string' && encoder.encode(value).length <= bytes && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : undefined;

type ToolPart = { data?: unknown; toolName?: string };

const managedTool = (value: unknown): BrowserReadTool | undefined =>
  typeof value === 'string' && tools.has(value) ? value as BrowserReadTool : undefined;

/** Conflicting identities suppress receipt attribution while retaining redaction. */
export function browserToolIdentity(part: ToolPart): { displayTool?: BrowserReadTool; receiptTool?: BrowserReadTool; redact: boolean } {
  const data = part?.data && typeof part.data === 'object' && !Array.isArray(part.data) ? part.data as Record<string, unknown> : {};
  const native = /^mcp__(.+?)__(.+)$/.exec(part?.toolName ?? '');
  const nativeTool = native?.[1] === 'threadterm' ? managedTool(native[2]) : undefined;
  const dataTool = data.server === 'threadterm' ? managedTool(data.tool) : undefined;
  const displayTool = nativeTool ?? (native ? undefined : dataTool);
  const consistent = displayTool && (data.server === undefined || data.server === 'threadterm')
    && (data.tool === undefined || data.tool === displayTool);
  return { displayTool, receiptTool: consistent ? displayTool : undefined, redact: Boolean(nativeTool || dataTool) };
}

export function browserToolNameFromPart(part: ToolPart): BrowserReadTool | undefined {
  return browserToolIdentity(part).receiptTool;
}

export function browserToolActivityFromPart(part: ToolPart): BrowserToolActivity | undefined {
  const tool = browserToolNameFromPart(part);
  const data = part?.data && typeof part.data === 'object' && !Array.isArray(part.data) ? part.data as Record<string, unknown> : {};
  return tool ? browserToolActivity(data.browserActivity, tool) : undefined;
}

export function hasRedactedBrowserResult(part: ToolPart): boolean {
  const data = part?.data;
  if (browserToolIdentity(part).redact) return true;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const value = data as Record<string, unknown>;
  return value.resultRedacted === true;
}

export function browserToolActivity(value: unknown, tool: string): BrowserToolActivity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !tools.has(tool)) return undefined;
  const data = value as Record<string, unknown>;
  if (data.tool !== tool || typeof data.outcome !== 'string' || !['running', 'completed', 'failed'].includes(data.outcome)) return undefined;
  const thumbnail = bounded(data.thumbnail, 22 * 1024);
  return {
    tool, outcome: data.outcome as BrowserToolActivity['outcome'],
    tabId: bounded(data.tabId, 256), title: bounded(data.title, 512),
    url: bounded(data.url, 8192), origin: bounded(data.origin, 4096),
    callerSessionId: bounded(data.callerSessionId, 256),
    thumbnail: tool === 'browser_screenshot' && thumbnail && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(thumbnail) ? thumbnail : undefined,
    provenanceUnavailable: data.provenanceUnavailable === true ? true : undefined,
  };
}
