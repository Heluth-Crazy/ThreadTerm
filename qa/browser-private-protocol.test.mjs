import test from 'node:test';
import assert from 'node:assert/strict';
import { isBrowserPrivateFrame, isBrowserMcpResult, isBrowserTabListResult, isBrowserActionReceipt, isBrowserToolArguments, isBrowserEvalArguments, isBrowserEvalScalar, isBrowserEvalReceipt, validateBrowserDesktopRequest, validateBrowserDesktopResult } from '../protocol/browser.js';

const registration = { attachmentId: 'attachment', attachmentGeneration: 1, runtimeEpoch: 'browser-boot', viewGeneration: 1, tabId: 'opaque-tab', sourceTabId: 'native-tab' };
const operation = { attachmentId: registration.attachmentId, attachmentGeneration: 1, runtimeEpoch: registration.runtimeEpoch, viewGeneration: 1, operationId: 'browser-boot:1', workerGeneration: 'worker' };
const execution = { method: 'browser.execute', params: { ...operation, invocationId: 'host:1', callerSessionId: 'caller', deadlineUnixMs: Date.now() + 10_000, tool: 'browser_snapshot', arguments: { tabId: registration.tabId }, targets: [registration] } };
const copy = value => structuredClone(value);
const evalFence = { ...operation, preparedId: 'prepared', tabId: registration.tabId, codeHash: 'a'.repeat(64), settingsGeneration: 'epoch:1', origin: 'https://example.invalid', documentGeneration: 1, navigationEpoch: 1, grantEpoch: 1 };
const evalPrepare = { method: 'browser.eval.prepare', params: { ...operation, invocationId: 'host:eval', callerSessionId: 'caller', turnId: 'turn', tabId: registration.tabId, codeHash: evalFence.codeHash, codeByteLength: 3, settingsGeneration: 'epoch:1', deadlineUnixMs: Date.now() + 10_000, target: registration } };
const evalExecute = { method: 'browser.eval.execute', params: { ...evalFence, invocationId: 'host:eval', callerSessionId: 'caller', turnId: 'turn', approvalId: 'approval', code: '1+1', codeByteLength: 3, deadlineUnixMs: Date.now() + 10_000 } };

test('eval preparation carries metadata only and binds one exact registered target', () => {
  assert.equal(isBrowserPrivateFrame(evalPrepare), true);
  assert.equal(isBrowserPrivateFrame({ ...evalPrepare, params: { ...evalPrepare.params, code: 'PRIVATE_CODE' } }), false);
  for (const [key, value] of Object.entries({ attachmentId: 'foreign', attachmentGeneration: 2, runtimeEpoch: 'retired', viewGeneration: 2, tabId: 'foreign-tab' })) {
    const changed = copy(evalPrepare); changed.params.target[key] = value;
    assert.equal(isBrowserPrivateFrame(changed), false, key);
  }
  for (const [key, value] of Object.entries({ codeHash: 'A'.repeat(64), codeByteLength: 0, settingsGeneration: '', turnId: '', deadlineUnixMs: Infinity })) {
    assert.equal(isBrowserPrivateFrame({ ...evalPrepare, params: { ...evalPrepare.params, [key]: value } }), false, key);
  }
});

test('approved eval bytes reject malformed UTF-16, NUL, byte mismatch and extra authority', () => {
  assert.equal(isBrowserPrivateFrame(evalExecute), true);
  assert.equal(isBrowserEvalArguments({ tabId: 'tab', code: ' \n😀\t' }), true);
  for (const code of ['', '\u0000', '\uD800', '\uDC00', '😀'.repeat(4097)]) {
    assert.equal(isBrowserEvalArguments({ tabId: 'tab', code }), false);
  }
  assert.equal(isBrowserEvalArguments({ tabId: 'tab', code: '😀'.repeat(4096) }), true);
  for (const [key, value] of Object.entries({ codeByteLength: 4, approvalId: '', grantEpoch: -1, navigationEpoch: 0.5, origin: 'https://example.invalid/path', principal: 'forged' })) {
    assert.equal(isBrowserPrivateFrame({ ...evalExecute, params: { ...evalExecute.params, [key]: value } }), false, key);
  }
  assert.equal(isBrowserToolArguments('browser_eval', { tabId: 'tab', code: '1+1' }), false);
  const ordinary = copy(execution); ordinary.params.tool = 'browser_eval'; ordinary.params.arguments = { tabId: registration.tabId, code: '1+1' };
  assert.equal(isBrowserPrivateFrame(ordinary), false);
});

test('eval private acknowledgements require all immutable fences and reject unbounded invalidation text', () => {
  assert.doesNotThrow(() => validateBrowserDesktopRequest('browser.desktop.evalPrepared', evalFence));
  assert.doesNotThrow(() => validateBrowserDesktopRequest('browser.desktop.dispatch', { ...evalFence, approvalId: 'approval' }));
  for (const key of Object.keys(evalFence)) {
    const partial = copy(evalFence); delete partial[key];
    assert.throws(() => validateBrowserDesktopRequest('browser.desktop.evalPrepared', partial), key);
    assert.throws(() => validateBrowserDesktopRequest('browser.desktop.dispatch', { ...partial, approvalId: 'approval' }), key);
  }
  const invalidated = { ...operation, preparedId: 'prepared', reason: 'browser_cancelled' };
  assert.doesNotThrow(() => validateBrowserDesktopRequest('browser.desktop.evalInvalidated', invalidated));
  assert.throws(() => validateBrowserDesktopRequest('browser.desktop.evalInvalidated', { ...invalidated, reason: 'PRIVATE_EXCEPTION' }));
  for (const method of ['browser.desktop.evalPrepared', 'browser.desktop.evalInvalidated']) {
    assert.doesNotThrow(() => validateBrowserDesktopResult(method, { accepted: true }));
    assert.throws(() => validateBrowserDesktopResult(method, { accepted: true, code: 'PRIVATE_CODE' }));
  }
});

test('eval results export only bounded tagged primitives and no value on noncompleted outcomes', () => {
  const source = { title: 'Fixture', url: 'https://example.invalid/', origin: 'https://example.invalid' };
  for (const result of [{ type: 'undefined' }, { type: 'null' }, { type: 'boolean', value: false }, { type: 'number', value: 0 }, { type: 'string', value: '😀'.repeat(4096) }]) {
    assert.equal(isBrowserEvalScalar(result), true);
    const receipt = { outcome: 'completed', source, result };
    assert.equal(isBrowserEvalReceipt(receipt), true);
    assert.doesNotThrow(() => validateBrowserDesktopRequest('browser.desktop.reply', { ...operation, result: receipt }));
    for (const outcome of ['failed', 'cancelled', 'outcome_unknown']) assert.equal(isBrowserEvalReceipt({ ...receipt, outcome }), false);
  }
  for (const result of [{ type: 'object', value: {} }, { type: 'promise' }, { type: 'number', value: Infinity }, { type: 'number', value: NaN }, { type: 'undefined', value: null }, { type: 'string', value: '\uD800' }, { type: 'string', value: '😀'.repeat(4097) }]) {
    assert.equal(isBrowserEvalScalar(result), false);
    assert.equal(isBrowserEvalReceipt({ outcome: 'completed', source, result }), false);
  }
  assert.equal(isBrowserEvalReceipt({ outcome: 'completed', source }), false);
  assert.equal(isBrowserEvalReceipt({ outcome: 'failed', code: 'browser_eval_unsupported_result' }), true);
  assert.equal(isBrowserEvalReceipt({ outcome: 'failed', exception: 'PRIVATE_EXCEPTION' }), false);
  assert.equal(isBrowserEvalReceipt({ outcome: 'completed', source, result: { type: 'string', value: '\u0000'.repeat(16384) } }), false, 'JSON escaping must respect the serialized receipt budget');
  for (const url of ['https://user:secret@example.invalid/', 'https://other.invalid/', 'file:///fixture']) {
    assert.equal(isBrowserEvalReceipt({ outcome: 'completed', source: { ...source, url }, result: { type: 'null' } }), false);
  }
  assert.equal(isBrowserEvalReceipt({ outcome: 'completed', source: { ...source, url: 'blob:https://example.invalid/opaque' }, result: { type: 'null' } }), true);
});

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

test('list and cancel messages remain strict and reject incomplete or unknown mutations', () => {
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
  assert.doesNotThrow(() => validateBrowserDesktopRequest('browser.desktop.dispatch', operation));
  assert.throws(() => validateBrowserDesktopRequest('browser.desktop.dispatch', { ...operation, mayHaveDispatched: true }));
  assert.throws(() => validateBrowserDesktopRequest('browser.desktop.dispatch', { ...operation, principal: 'forged' }));
  assert.doesNotThrow(() => validateBrowserDesktopResult('browser.desktop.dispatch', { accepted: true }));
  assert.throws(() => validateBrowserDesktopResult('browser.desktop.dispatch', { accepted: false }));
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
  assert.equal(isBrowserTabListResult({ tabs: [{ ...tab, shareLevel: 'control' }], truncated: false }), true);
  assert.equal(isBrowserTabListResult({ tabs: [{ ...tab, shareLevel: 'off' }], truncated: false }), false);
  assert.equal(isBrowserTabListResult({ tabs: [{ ...tab, title: '😀'.repeat(129) }], truncated: false }), false);
  assert.equal(isBrowserTabListResult({ tabs: [{ ...tab, principal: 'another-client' }], truncated: false }), false);
  assert.equal(isBrowserTabListResult({ tabs: Array(257).fill(tab), truncated: true }), false);
});

test('targeted actions require exact refs, bounded UTF-8 data and page-only keys', () => {
  const target = { tabId: registration.tabId, ref: 'opaque-ref' };
  const cases = [
    ['browser_navigate', { tabId: registration.tabId, url: 'https://example.invalid/next' }],
    ['browser_click', target],
    ['browser_hover', target],
    ['browser_type', { ...target, text: '' }],
    ['browser_type', { ...target, text: 'first\nsecond\tvalue' }],
    ['browser_press_key', { ...target, key: 'Enter' }],
    ['browser_select_option', { ...target, values: ['', 'second'] }],
    ['browser_select_option', { ...target, values: [] }],
  ];
  for (const [tool, args] of cases) {
    assert.equal(isBrowserToolArguments(tool, args), true, tool);
    const frame = copy(execution); frame.params.tool = tool; frame.params.arguments = args;
    assert.equal(isBrowserPrivateFrame(frame), true, tool);
    assert.equal(isBrowserToolArguments(tool, { ...args, x: 10 }), false, tool);
    assert.equal(isBrowserToolArguments(tool, { ...args, callerSessionId: 'forged' }), false, tool);
    assert.equal(isBrowserToolArguments(tool, { ...args, tabId: 'tab\nforged' }), false, tool);
  }
  for (const tool of ['browser_click', 'browser_hover', 'browser_type', 'browser_press_key', 'browser_select_option']) {
    assert.equal(isBrowserToolArguments(tool, { tabId: 'tab' }), false, tool);
  }
  for (const key of ['Control+A', 'Alt+F4', 'Meta', 'F12', 'a', ' ', null]) {
    assert.equal(isBrowserToolArguments('browser_press_key', { ...target, key }), false);
  }
  assert.equal(isBrowserToolArguments('browser_type', { ...target, text: '😀'.repeat(4096) }), true);
  assert.equal(isBrowserToolArguments('browser_type', { ...target, text: '😀'.repeat(4097) }), false);
  assert.equal(isBrowserToolArguments('browser_type', { ...target, text: 'nul\u0000value' }), false);
  for (const values of [['duplicate', 'duplicate'], Array(101).fill('x'), ['😀'.repeat(4097)], ['nul\u0000value'], [1]]) {
    assert.equal(isBrowserToolArguments('browser_select_option', { ...target, values }), false);
  }
  assert.equal(isBrowserToolArguments('browser_select_option', { ...target, values: ['😀'.repeat(4096)] }), true);
});

test('navigation cannot request credentials, app schemes or executable URLs', () => {
  for (const url of ['https://user:secret@example.invalid/', 'https://user@example.invalid/', 'javascript:alert(1)', 'file:///D:/secret', 'data:text/html,test', 'threadterm://app', '/relative', 'https://example.invalid/\nforged']) {
    assert.equal(isBrowserToolArguments('browser_navigate', { tabId: 'tab', url }), false, url);
  }
  assert.equal(isBrowserToolArguments('browser_navigate', { tabId: 'tab', url: 'https://example.invalid/' + 'x'.repeat(8192) }), false);
  assert.equal(isBrowserToolArguments('browser_eval', { tabId: 'tab', code: '1+1' }), false);
});

test('action receipts contain bounded status and source metadata rather than page or input payloads', () => {
  const source = { title: 'Source page', url: 'https://example.invalid/', origin: 'https://example.invalid' };
  const receipt = { outcome: 'completed', source, navigation: { admitted: true, sharingRevoked: true } };
  assert.equal(isBrowserActionReceipt(receipt), true);
  assert.doesNotThrow(() => validateBrowserDesktopRequest('browser.desktop.reply', { ...operation, result: receipt }));
  for (const outcome of ['failed', 'cancelled', 'outcome_unknown']) {
    assert.equal(isBrowserActionReceipt({ outcome, code: 'browser_outcome_unknown', source }), true);
  }
  for (const extra of [{ text: 'typed secret' }, { content: [] }, { callerSessionId: 'forged' }, { mayHaveDispatched: false }]) {
    assert.equal(isBrowserActionReceipt({ ...receipt, ...extra }), false);
  }
  assert.equal(isBrowserActionReceipt({ ...receipt, code: 'page-supplied secret' }), false);
  assert.equal(isBrowserActionReceipt({ ...receipt, source: { ...source, title: '😀'.repeat(129) } }), false);
  assert.equal(isBrowserActionReceipt({ ...receipt, source: { ...source, text: 'page body' } }), false);
  assert.equal(isBrowserActionReceipt({ ...receipt, navigation: { admitted: true, sharingRevoked: true, verified: true } }), false);
  assert.equal(isBrowserActionReceipt({ outcome: 'completed' }), false);
});
