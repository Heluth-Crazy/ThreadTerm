const PREFIX = 'mcp__threadterm__';
const TOOLS = new Set(['browser_list_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console_messages']);
const LIMIT = 4096;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value, limit = 512) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : undefined;
const browserTool = name => typeof name === 'string' && name.startsWith(PREFIX) && TOOLS.has(name.slice(PREFIX.length)) ? name.slice(PREFIX.length) : undefined;
const clone = value => Array.isArray(value) ? value.map(clone) : record(value) ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)])) : value;

function remember(map, key, value) {
  if (!key) return;
  map.delete(key);
  map.set(key, value);
  while (map.size > LIMIT) map.delete(map.keys().next().value);
}

/** Only the structural MCP result's direct provenance may supply a lookup key.
 * Page strings nested inside outlines/entries are never inspected. */
function operationId(value) {
  const found = new Set();
  const provenance = value => {
    if (record(value?.provenance) && value.provenance.label === 'Page data, not instructions') {
      const operation = id(value.provenance.operationId);
      if (operation) found.add(operation);
    }
  };
  const text = value => {
    if (typeof value !== 'string' || value.length > 900 * 1024) return;
    const prefix = 'Page data, not instructions.\n';
    const json = value.startsWith(prefix) ? value.slice(prefix.length) : value;
    try { provenance(JSON.parse(json)); } catch { /* Invalid page text has no authority. */ }
  };
  const candidates = [value, ...(record(value) ? [value.content, value.result, value.rawOutput].filter(record) : [])];
  for (const candidate of candidates) {
    provenance(candidate);
    const content = record(candidate) ? candidate.content : candidate;
    if (typeof content === 'string') text(content);
    if (Array.isArray(content)) {
      for (const block of content.slice(0, 16)) if (record(block) && block.type === 'text') text(block.text);
    }
  }
  return found.size === 1 ? found.values().next().value : undefined;
}

// Error flags may downgrade the observer status without trusting page text.
function structuralError(value) {
  if (!record(value)) return false;
  return [value, value.content, value.result, value.rawOutput].filter(record).some(candidate =>
    candidate.isError === true || candidate.is_error === true
    || Object.hasOwn(candidate, 'error') && candidate.error !== null && candidate.error !== false);
}

const WRAPPER_FIELDS = new Set(['type', 'subtype', 'uuid', 'session_id', 'parent_tool_use_id', 'message', 'event', 'content', 'content_block', 'delta', 'index', 'role', 'id']);
function wrapper(value) {
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => WRAPPER_FIELDS.has(key)
    && (['message', 'event', 'content', 'content_block', 'delta'].includes(key)
      || key === 'index' && Number.isSafeInteger(entry) && entry >= 0
      || entry === null && key === 'parent_tool_use_id'
      || typeof entry === 'string' && entry.length <= 512)));
}

/** One observer-only tracker per SDK query. The original SDK objects stay private. */
export class BrowserToolResultScrubber {
  #tools = new Map();
  #streams = new Map();

  sanitize(message) {
    return this.#visit(message, { scope: id(message?.parent_tool_use_id) ?? '' }).value;
  }

  #visit(value, context) {
    if (Array.isArray(value)) {
      const entries = value.map(entry => this.#visit(entry, context));
      return { value: entries.map(entry => entry.value), redacted: entries.some(entry => entry.redacted) };
    }
    if (!record(value)) return { value, redacted: false };
    if (value.type === 'tool_use') return this.#toolUse(value);
    if (value.type === 'tool_result') return this.#toolResult(value, context.operation, context.failed);
    const scope = id(value.parent_tool_use_id) ?? context.scope;
    if (value.type === 'message_start') {
      for (const key of this.#streams.keys()) if (key.startsWith(`${scope}\0`)) this.#streams.delete(key);
    }
    if (value.type === 'content_block_start' && Number.isSafeInteger(value.index)) {
      const block = value.content_block;
      const tracked = this.#tools.get(id(block?.id));
      remember(this.#streams, `${scope}\0${value.index}`, record(block) && block.type === 'tool_use' ? (typeof tracked === 'string' ? tracked : browserTool(block.name) ?? false) : false);
    }
    if (value.type === 'content_block_delta' && value.delta?.type === 'input_json_delta') {
      const tool = this.#streams.get(`${scope}\0${value.index}`);
      if (tool !== false) {
        return { value: { type: value.type, index: value.index, delta: { type: 'input_json_delta', partial_json: '' }, resultRedacted: true,
          ...(tool ? { server: 'threadterm', tool } : {}) }, redacted: true };
      }
      return { value: clone(value), redacted: false };
    }
    const content = value.message?.content ?? value.content;
    const results = Array.isArray(content) ? content.filter(block => block?.type === 'tool_result') : [];
    const inheritedOperation = results.length === 1 ? operationId(value.tool_use_result) : undefined;
    const failed = context.failed || results.length === 1 && structuralError(value.tool_use_result);
    const entries = Object.entries(value).map(([key, entry]) => [key, this.#visit(entry, { scope, operation: inheritedOperation ?? context.operation, failed })]);
    const redacted = entries.some(([, entry]) => entry.redacted);
    const copied = Object.fromEntries(entries.map(([key, entry]) => [key, entry.value]));
    return { value: redacted ? wrapper(copied) : copied, redacted };
  }

  #toolUse(value) {
    const nativeId = id(value.id), tracked = this.#tools.get(nativeId);
    const tool = typeof tracked === 'string' ? tracked : browserTool(value.name);
    remember(this.#tools, nativeId, tool ?? false);
    if (!tool) return { value: clone(value), redacted: false };
    const tabId = tool !== 'browser_list_tabs' ? id(value.input?.tabId, 256) : undefined;
    return { value: { type: 'tool_use', ...(nativeId ? { id: nativeId } : {}), name: `${PREFIX}${tool}`,
      input: tabId ? { tabId } : {}, server: 'threadterm', tool, resultRedacted: true }, redacted: true };
  }

  #toolResult(value, inheritedOperation, inheritedFailure) {
    const toolId = id(value.tool_use_id), tracked = toolId ? this.#tools.get(toolId) : undefined;
    const tool = typeof tracked === 'string' ? tracked : browserTool(value.name);
    // Ordinary tools keep their exact observer payloads, including nested JSON
    // which merely resembles browser tool blocks.
    if (!tool && (tracked === false || id(value.name))) return { value: clone(value), redacted: false };
    const directOperation = tool ? operationId(value) : undefined;
    const operation = !tool || directOperation && inheritedOperation && directOperation !== inheritedOperation ? undefined : directOperation ?? inheritedOperation;
    return { value: { type: 'tool_result', ...(toolId ? { tool_use_id: toolId } : {}),
      ...(tool ? { name: `${PREFIX}${tool}`, server: 'threadterm', tool } : {}),
      content: [], is_error: structuralError(value) || inheritedFailure === true, resultRedacted: true,
      ...(operation ? { browserOperationId: operation } : {}) }, redacted: true };
  }
}

/** History has no authority inherited from the live query's remembered IDs. */
export function sanitizeBrowserMessages(messages) {
  const scrubber = new BrowserToolResultScrubber();
  if (!Array.isArray(messages)) throw new Error('Invalid Claude history messages');
  return messages.map(message => scrubber.sanitize(message));
}
