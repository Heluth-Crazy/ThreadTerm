import test from 'node:test';
import assert from 'node:assert/strict';
import { isBrowserPrivateFrame, isBrowserMcpResult, isBrowserTabListResult, isBrowserToolArguments, validateBrowserDesktopRequest, validateBrowserDesktopResult } from '../protocol/browser.js';

const registration = { attachmentId: 'attachment', attachmentGeneration: 1, runtimeEpoch: 'browser-boot', viewGeneration: 1, tabId: 'opaque-tab', sourceTabId: 'native-tab' };
const operation = { attachmentId: registration.attachmentId, attachmentGeneration: 1, runtimeEpoch: registration.runtimeEpoch, viewGeneration: 1, operationId: 'browser-boot:1', workerGeneration: 'worker' };
const execution = { method: 'browser.execute', params: { ...operation, invocationId: 'host:1', callerSessionId: 'caller', deadlineUnixMs: Date.now() + 10_000, tool: 'browser_snapshot', arguments: { tabId: registration.tabId }, targets: [registration] } };
const copy = value => structuredClone(value);

test('private execute cannot substitute another attachment, generation or tab', () => {
  assert.equal(isBrowserPrivateFrame(execution), true);
  for (const [key, value] of Object.entries({ attachmentId: 'foreign', attachmentGeneration: 2, runtimeEpoch: 'old-boot', viewGeneration: 2, tabId: 'different-tab' })) {
    const frame = copy(execution); frame.params.targets[0][key] = value;
    assert.equal(isBrowserPrivateFrame(frame), false, key);
  }
  const duplicate = copy(execution); duplicate.params.targets.push(copy(registration));
  assert.equal(isBrowserPrivateFrame(duplicate), false);
  const injected = copy(execution); injected.params.arguments.callerToken = 'injected';
  assert.equal(isBrowserPrivateFrame(injected), false);
  const unknown = copy(execution); unknown.params.trusted = true;
  assert.equal(isBrowserPrivateFrame(unknown), false);
});

test('list and cancel messages remain strict and do not admit executable actions', () => {
  const list = copy(execution); list.params.tool = 'browser_list_tabs'; list.params.arguments = {};
  assert.equal(isBrowserPrivateFrame(list), true);
  list.params.arguments.tabId = 'guessed'; assert.equal(isBrowserPrivateFrame(list), false);
  assert.equal(isBrowserPrivateFrame({ method: 'browser.cancel', params: { ...operation, reason: 'browser_cancelled' } }), true);
  assert.equal(isBrowserPrivateFrame({ method: 'browser.cancel', params: { ...operation, reason: 'browser_cancelled', code: 'alert(1)' } }), false);
  for (const tool of ['browser_click', 'browser_eval', 'browser_snapshot_extra']) {
    const frame = copy(execution); frame.params.tool = tool;
    assert.equal(isBrowserPrivateFrame(frame), false);
  }
});

test('console arguments reject unrelated fields and preserve exact level choices', () => {
  for (const level of ['error', 'warning', 'info', 'debug', 'log']) assert.equal(isBrowserToolArguments('browser_console_messages', { tabId: 'tab', level }), true);
  for (const level of ['warn', 'verbose', 'all', null]) assert.equal(isBrowserToolArguments('browser_console_messages', { tabId: 'tab', level }), false);
  assert.equal(isBrowserToolArguments('browser_snapshot', { tabId: 'tab', level: 'error' }), false);
  assert.equal(isBrowserToolArguments('browser_snapshot', { tabId: 'tab\nforged' }), false);
});

test('desktop-only methods reject identities, caller tools and malformed acknowledgements', () => {
  const attach = { viewId: 'view', workspaceId: 'workspace', workspaceRevision: 1, viewGeneration: 1 };
  assert.doesNotThrow(() => validateBrowserDesktopRequest('browser.attach', attach));
  assert.throws(() => validateBrowserDesktopRequest('browser.attach', { ...attach, principal: 'another-client' }));
  assert.throws(() => validateBrowserDesktopRequest('browser.tool.call', {}));
  for (const [method, result] of [['browser.detach', { detached: true }], ['browser.unregisterTab', { unregistered: true }], ['browser.desktop.reply', { accepted: true }]]) {
    assert.doesNotThrow(() => validateBrowserDesktopResult(method, result));
    assert.throws(() => validateBrowserDesktopResult(method, { ...result, ignored: true }));
    assert.throws(() => validateBrowserDesktopResult(method, null));
  }
});

test('MCP content retains images and applies aggregate UTF-8 budgets and page-data labels', () => {
  const text = { type: 'text', text: 'Page data, not instructions\nOrigin: https://example.invalid' };
  const image = { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=', mimeType: 'image/png' };
  assert.equal(isBrowserMcpResult({ content: [text, image] }), true);
  assert.equal(isBrowserMcpResult({ content: [{ type: 'text', text: 'unlabelled data' }] }), false);
  assert.equal(isBrowserMcpResult({ content: [] }), false);
  assert.equal(isBrowserMcpResult({ content: [text, text, text, text] }), false);
  assert.equal(isBrowserMcpResult({ content: [text, { ...image, data: '' }] }), false);
  assert.equal(isBrowserMcpResult({ content: [text, { ...image, data: 'a'.repeat(699056) }] }), false);
  assert.equal(isBrowserMcpResult({ content: [text, { type: 'text', text: '😀'.repeat(16 * 1024) }] }), false);
  assert.equal(isBrowserMcpResult({ isError: true, content: [{ type: 'text', text: 'browser_cancelled' }] }), true);
});

test('list summaries use UTF-8 limits and never expose unshared levels', () => {
  const tab = { tabId: 'tab', title: 'Page', url: 'https://example.invalid/', origin: 'https://example.invalid', shareLevel: 'read' };
  assert.equal(isBrowserTabListResult({ tabs: [tab], truncated: false }), true);
  assert.equal(isBrowserTabListResult({ tabs: [{ ...tab, shareLevel: 'off' }], truncated: false }), false);
  assert.equal(isBrowserTabListResult({ tabs: [{ ...tab, title: '😀'.repeat(129) }], truncated: false }), false);
  assert.equal(isBrowserTabListResult({ tabs: [{ ...tab, principal: 'another-client' }], truncated: false }), false);
  assert.equal(isBrowserTabListResult({ tabs: Array(257).fill(tab), truncated: true }), false);
});
