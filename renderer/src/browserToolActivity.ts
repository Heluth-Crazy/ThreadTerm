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

export function browserToolActivityFromPart(part: ToolPart): BrowserToolActivity | undefined {
  const data = part?.data && typeof part.data === 'object' && !Array.isArray(part.data) ? part.data as Record<string, unknown> : {};
  const native = /^mcp__threadterm__(.+)$/.exec(part?.toolName ?? '');
  const server = typeof data.server === 'string' && data.server.trim() ? data.server.trim() : native ? 'threadterm' : undefined;
  const tool = typeof data.tool === 'string' && data.tool.trim() ? data.tool.trim() : native?.[1];
  return server === 'threadterm' && tool ? browserToolActivity(data.browserActivity, tool) : undefined;
}

export function hasRedactedBrowserResult(part: ToolPart): boolean {
  const data = part?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const value = data as Record<string, unknown>;
  return value.resultRedacted === true || browserToolActivityFromPart(part) !== undefined;
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
