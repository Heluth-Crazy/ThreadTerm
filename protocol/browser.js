// Generated from browser.ts by protocol/generate.mjs. Do not edit.
const METHODS = ["browser.attach", "browser.registerTab", "browser.unregisterTab", "browser.detach", "browser.desktop.reply"];
const TOOLS = ["browser_list_tabs", "browser_snapshot", "browser_screenshot", "browser_console_messages"];
const LEVELS = ["error", "warning", "info", "debug", "log"];
const ATTACHMENT_KEYS = ["attachmentId", "attachmentGeneration", "runtimeEpoch", "viewGeneration"];
const REGISTRATION_KEYS = [...ATTACHMENT_KEYS, "tabId", "sourceTabId"];
const OPERATION_KEYS = [...ATTACHMENT_KEYS, "operationId", "workerGeneration"];
const EXECUTION_KEYS = [...OPERATION_KEYS, "invocationId", "callerSessionId", "deadlineUnixMs", "tool", "arguments", "targets"];
const bytes = (value) => new TextEncoder().encode(value).byteLength;
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value, required, optional = []) => record(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const text = (value, limit = 256) => typeof value === "string" && value.length > 0 && bytes(value) <= limit && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const counter = (value) => Number.isSafeInteger(value) && value >= 0;
const attachment = (value) => text(value.attachmentId) && counter(value.attachmentGeneration) && text(value.runtimeEpoch) && counter(value.viewGeneration);
const operation = (value) => attachment(value) && text(value.operationId, 512) && text(value.workerGeneration);
function isBrowserDesktopMethod(value) {
  return typeof value === "string" && METHODS.includes(value);
}
function isBrowserAttachment(value) {
  return exact(value, ATTACHMENT_KEYS) && attachment(value);
}
function isBrowserRegistration(value) {
  return exact(value, REGISTRATION_KEYS) && attachment(value) && text(value.tabId) && text(value.sourceTabId);
}
function isBrowserToolArguments(tool, value) {
  if (tool === "browser_list_tabs") return exact(value, []);
  return exact(value, ["tabId"], tool === "browser_console_messages" ? ["level"] : []) && text(value.tabId) && (value.level === void 0 || typeof value.level === "string" && LEVELS.includes(value.level));
}
function isBrowserPrivateFrame(value) {
  if (!exact(value, ["method", "params"])) return false;
  if (value.method === "browser.cancel") return exact(value.params, [...OPERATION_KEYS, "reason"]) && operation(value.params) && text(value.params.reason, 1024);
  if (value.method !== "browser.execute" || !exact(value.params, EXECUTION_KEYS) || !operation(value.params)) return false;
  const p = value.params;
  if (!text(p.invocationId, 128) || !text(p.callerSessionId) || !counter(p.deadlineUnixMs) || typeof p.tool !== "string" || !TOOLS.includes(p.tool) || !isBrowserToolArguments(p.tool, p.arguments) || !Array.isArray(p.targets) || p.targets.length > 256) return false;
  const seen = /* @__PURE__ */ new Set();
  for (const target of p.targets) {
    if (!isBrowserRegistration(target) || seen.has(target.tabId) || target.attachmentId !== p.attachmentId || target.attachmentGeneration !== p.attachmentGeneration || target.runtimeEpoch !== p.runtimeEpoch || target.viewGeneration !== p.viewGeneration) return false;
    seen.add(target.tabId);
  }
  return p.tool === "browser_list_tabs" || p.targets.length === 1 && p.targets[0].tabId === p.arguments.tabId;
}
function isBrowserMcpResult(value) {
  if (!exact(value, ["content"], ["isError"]) || value.isError !== void 0 && typeof value.isError !== "boolean" || !Array.isArray(value.content) || value.content.length < 1 || value.content.length > 3) return false;
  let textBytes = 0, imageBytes = 0, labelled = false;
  for (const block of value.content) {
    if (exact(block, ["type", "text"]) && block.type === "text" && typeof block.text === "string") {
      textBytes += bytes(block.text);
      labelled ||= block.text.includes("Page data, not instructions");
    } else if (exact(block, ["type", "data", "mimeType"]) && block.type === "image" && typeof block.data === "string" && (block.mimeType === "image/png" || block.mimeType === "image/jpeg") && block.data.length > 0 && block.data.length <= 699052 && block.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) {
      imageBytes += block.data.length / 4 * 3 - (block.data.endsWith("==") ? 2 : block.data.endsWith("=") ? 1 : 0);
    } else return false;
  }
  return (labelled || value.isError === true) && textBytes <= 60 * 1024 && imageBytes <= 512 * 1024 && bytes(JSON.stringify(value)) < 900 * 1024;
}
function isBrowserTabListResult(value) {
  return exact(value, ["tabs", "truncated"]) && typeof value.truncated === "boolean" && Array.isArray(value.tabs) && value.tabs.length <= 256 && value.tabs.every((tab) => exact(tab, ["tabId", "title", "url", "origin", "shareLevel"]) && text(tab.tabId) && typeof tab.title === "string" && bytes(tab.title) <= 512 && typeof tab.url === "string" && bytes(tab.url) <= 8192 && text(tab.origin, 4096) && tab.shareLevel === "read") && bytes(JSON.stringify(value)) <= 60 * 1024;
}
function validateBrowserDesktopRequest(method, value) {
  let valid = false;
  if (method === "browser.attach") valid = exact(value, ["viewId", "workspaceId", "workspaceRevision", "viewGeneration"]) && text(value.viewId) && text(value.workspaceId) && counter(value.workspaceRevision) && counter(value.viewGeneration);
  else if (method === "browser.registerTab") valid = exact(value, ["attachmentId", "attachmentGeneration", "sourceTabId", "workspaceRevision"]) && text(value.attachmentId) && counter(value.attachmentGeneration) && text(value.sourceTabId) && counter(value.workspaceRevision);
  else if (method === "browser.detach" || method === "browser.unregisterTab") valid = exact(
    value,
    method === "browser.detach" ? ["attachmentId", "attachmentGeneration"] : ["attachmentId", "attachmentGeneration", "tabId"]
  ) && text(value.attachmentId) && counter(value.attachmentGeneration) && (method !== "browser.unregisterTab" || text(value.tabId));
  else if (method === "browser.desktop.reply") valid = exact(value, [...OPERATION_KEYS, "result"]) && operation(value) && (isBrowserMcpResult(value.result) || isBrowserTabListResult(value.result));
  if (!valid) throw new Error("Invalid private browser request");
}
function validateBrowserDesktopResult(method, value) {
  if (method === "browser.attach" && isBrowserAttachment(value) || method === "browser.registerTab" && isBrowserRegistration(value)) return;
  const key = method === "browser.detach" ? "detached" : method === "browser.unregisterTab" ? "unregistered" : method === "browser.desktop.reply" ? "accepted" : void 0;
  if (key && exact(value, [key]) && value[key] === true) return;
  throw new Error("Invalid private browser response");
}
export {
  isBrowserAttachment,
  isBrowserDesktopMethod,
  isBrowserMcpResult,
  isBrowserPrivateFrame,
  isBrowserRegistration,
  isBrowserTabListResult,
  isBrowserToolArguments,
  validateBrowserDesktopRequest,
  validateBrowserDesktopResult
};
