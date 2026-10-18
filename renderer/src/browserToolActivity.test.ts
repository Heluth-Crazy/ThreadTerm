import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatPart } from '@threadterm/protocol';
import { browserToolActivity, browserToolActivityFromPart, browserToolNameFromPart, hasRedactedBrowserResult } from './browserToolActivity';
import { partBody, partLabel } from './chatPresentation';
import { toolView } from './toolView';
import { describeTool, toolOutputPreview, toolStatus, toolSummary } from './toolActivity';

const receipt = { tool: 'browser_snapshot', outcome: 'completed', title: '<script>page title</script>', origin: 'https://example.test', callerSessionId: 'chat-a' };
const actions = ['browser_navigate', 'browser_click', 'browser_type', 'browser_hover', 'browser_press_key', 'browser_select_option'];

test('browser receipts preserve bounded provenance and discard every raw sibling', () => {
  const activity = browserToolActivity({ ...receipt, snapshot: 'PRIVATE', result: 'PRIVATE', content: ['PRIVATE'] }, receipt.tool);
  assert.deepEqual(activity, { ...receipt, tabId: undefined, url: undefined, thumbnail: undefined, provenanceUnavailable: undefined });
  assert.equal(JSON.stringify(activity).includes('PRIVATE'), false);
  assert.equal(browserToolActivity({ ...receipt, tool: 'browser_eval_extra' }, 'browser_eval_extra'), undefined);
  assert.equal(browserToolActivity(receipt, 'browser_screenshot'), undefined);
  assert.equal(browserToolActivity({ ...receipt, outcome: { toString: 'completed' } }, receipt.tool), undefined);
});

test('invalid receipt fields and unbounded or non-JPEG thumbnails are omitted', () => {
  const activity = browserToolActivity({ ...receipt, title: '\u754c'.repeat(171), origin: 'unsafe\norigin', thumbnail: 'data:image/jpeg;base64,YQ==' }, receipt.tool)!;
  assert.equal(activity.title, undefined);
  assert.equal(activity.origin, undefined);
  assert.equal(activity.thumbnail, undefined);
  for (const thumbnail of ['https://example.test/pixel', 'data:image/svg+xml;base64,YQ==', `data:image/jpeg;base64,${'a'.repeat(23000)}`]) {
    assert.equal(browserToolActivity({ ...receipt, tool: 'browser_screenshot', thumbnail }, 'browser_screenshot')!.thumbnail, undefined);
  }
});

test('browser card classification never falls back to raw result or args for redacted receipts', () => {
  for (const browserActivity of [receipt, { ...receipt, outcome: 'invalid' }]) {
    const part = { type: 'tool', toolName: 'mcp__threadterm__browser_snapshot', status: 'completed', data: {
      type: 'mcpToolCall', server: 'threadterm', tool: 'browser_snapshot', browserActivity,
      resultRedacted: true, result: 'PRIVATE RESULT', arguments: { text: 'PRIVATE ARGUMENT' },
    } } as ChatPart;
    const view = toolView(part);
    assert.equal(view.kind, 'mcp');
    if (view.kind === 'mcp') { assert.equal(view.args, undefined); assert.equal(view.result, undefined); }
    assert.equal(JSON.stringify(view).includes('PRIVATE'), false);
  }
});

test('ordinary MCP tools retain their existing arguments and results', () => {
  const view = toolView({ type: 'tool', toolName: 'mcp__filesystem__read_file', data: { server: 'filesystem', tool: 'read_file', arguments: { path: 'a.txt' }, result: 'ordinary output' } } as ChatPart);
  assert.equal(view.kind, 'mcp');
  if (view.kind === 'mcp') { assert.deepEqual(view.args, { path: 'a.txt' }); assert.equal(view.result, 'ordinary output'); }
});

test('collapsed summaries cannot bypass browser redaction and read failures remain failures', () => {
  const part = { type: 'tool', status: 'completed', data: { server: 'threadterm', tool: receipt.tool,
    browserActivity: { ...receipt, outcome: 'failed' }, resultRedacted: true,
    result: { content: [{ type: 'text', text: 'PRIVATE RESULT' }] }, rawOutput: 'PRIVATE OUTPUT',
  } } satisfies ChatPart;
  assert.equal(toolOutputPreview(part), undefined);
  assert.equal(toolStatus(part), 'failed');
  assert.equal(toolStatus({ ...part, status: 'cancelled' }), 'cancelled');
  assert.equal(toolStatus({ ...part, data: { ...part.data as object, server: 'unrelated' } }), 'complete');
  const fallback = { ...part, toolName: 'mcp__threadterm__browser_snapshot', data: {
    browserActivity: { ...receipt, outcome: 'failed' }, result: { content: [{ type: 'text', text: 'PRIVATE' }] },
  } } as ChatPart;
  assert.equal(toolStatus(fallback), 'failed');
  assert.equal(toolOutputPreview(fallback), undefined);
});

test('all action identities redact native echoes across typed cards and collapsed summaries without a receipt', () => {
  for (const tool of actions) for (const managedFields of [true, false]) {
    const part = { type: 'tool', toolName: `mcp__threadterm__${tool}`, status: 'completed', data: {
      ...(managedFields ? { type: 'mcpToolCall', server: 'threadterm', tool } : {}),
      input: { tabId: 'public-tab', text: 'PRIVATE', code: 'PRIVATE', values: ['PRIVATE'], ref: 'PRIVATE',
        url: 'https://example.test/PRIVATE', selector: 'PRIVATE', element: 'PRIVATE' },
      rawInput: 'PRIVATE', result: { content: [{ type: 'text', text: 'PRIVATE' }] }, rawOutput: 'PRIVATE',
      title: 'PRIVATE', images: ['PRIVATE'],
    } } as ChatPart;
    assert.equal(browserToolNameFromPart(part), tool);
    assert.equal(hasRedactedBrowserResult(part), true);
    const view = toolView(part);
    assert.equal(view.kind, 'mcp');
    assert.equal(JSON.stringify(view).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(describeTool(part, en => en)).includes('PRIVATE'), false);
    assert.equal(toolOutputPreview(part), undefined);
  }
});

test('authenticated uncertain actions are settled failures with an unknown outcome and no raw metadata upgrade', () => {
  for (const tool of actions) for (const nativeStatus of ['completed', 'running', 'cancelled']) {
    const part = { type: 'tool', toolName: `mcp__threadterm__${tool}`, status: nativeStatus, data: {
      browserActivity: { ...receipt, tool, outcome: 'outcome_unknown', thumbnail: 'data:image/jpeg;base64,YQ==',
        text: 'PRIVATE', code: 'PRIVATE', values: ['PRIVATE'] }, isError: true,
    } } as ChatPart;
    const view = toolView(part);
    assert.equal(view.status, 'failed');
    assert.equal(toolSummary([{ id: tool, itemId: tool, part }]).failed, 1);
    if (view.kind !== 'mcp') assert.fail('action must remain MCP');
    assert.equal(view.browserActivity?.outcome, 'outcome_unknown');
    assert.equal(view.browserActivity?.thumbnail, undefined);
    assert.equal(JSON.stringify(view).includes('PRIVATE'), false);
    const cancelled = { ...part, data: { ...part.data as object, browserActivity: { ...receipt, tool, outcome: 'cancelled' } } } as ChatPart;
    assert.equal(toolStatus(cancelled), 'cancelled');
    const noReceipt = { ...part, data: { isError: true, result: 'PRIVATE', browserActivity: { tool, outcome: 'invented', origin: 'PRIVATE' } } } as ChatPart;
    assert.equal(toolStatus(noReceipt), nativeStatus === 'cancelled' ? 'cancelled' : 'failed');
    assert.equal(toolView(noReceipt).kind, 'mcp');
    assert.equal(JSON.stringify(toolView(noReceipt)).includes('PRIVATE'), false);
  }
});

test('foreign tools and noncanonical action names keep ordinary MCP data and cannot acquire browser receipts', () => {
  for (const tool of actions) {
    for (const [server, name] of [['foreign', tool], ['threadterm', `${tool}_extra`], ['threadterm', `${tool} `], ['threadterm', 'browser_eval_extra']]) {
      const part = { type: 'tool', toolName: `mcp__${server}__${name}`, data: {
        server, tool: name, input: { text: 'ordinary input' }, result: 'ordinary output',
        browserActivity: { ...receipt, tool, outcome: 'outcome_unknown' },
      } } as ChatPart;
      assert.equal(browserToolNameFromPart(part), undefined);
      assert.equal(hasRedactedBrowserResult(part), false);
      const view = toolView(part);
      if (view.kind !== 'mcp') assert.fail('ordinary MCP shape changed');
      assert.deepEqual(view.args, { text: 'ordinary input' });
      assert.equal(view.result, 'ordinary output');
      assert.equal(view.browserActivity, undefined);
    }
  }
});

test('conflicting native and data identities always redact without borrowing receipt attribution', () => {
  for (const tool of ['browser_list_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console_messages', ...actions]) {
    for (const conflict of [
      { native: `mcp__threadterm__${tool}`, server: 'PRIVATE SERVER', tool: 'PRIVATE TOOL', safeTitle: `threadterm: ${tool}` },
      { native: `mcp__threadterm__${tool}`, server: 'threadterm', tool: 'browser_snapshot_extra', safeTitle: `threadterm: ${tool}` },
      { native: `mcp__foreign__${tool}`, server: 'threadterm', tool, safeTitle: 'Browser tool' },
    ]) {
      const part = { type: 'tool', toolName: conflict.native, status: 'completed', data: {
        server: conflict.server, tool: conflict.tool, input: { text: 'PRIVATE', url: 'https://PRIVATE', values: ['PRIVATE'] },
        result: 'PRIVATE', rawOutput: 'PRIVATE', images: ['PRIVATE'],
        browserActivity: { tool, outcome: 'outcome_unknown', origin: 'https://PRIVATE', title: 'PRIVATE', thumbnail: 'data:image/jpeg;base64,YQ==' },
      } } as ChatPart;
      assert.equal(hasRedactedBrowserResult(part), true);
      assert.equal(browserToolNameFromPart(part), undefined);
      assert.equal(browserToolActivityFromPart(part), undefined);
      assert.equal(toolOutputPreview(part), undefined);
      const view = toolView(part);
      assert.equal(view.title, conflict.safeTitle);
      assert.equal(view.status, 'complete', 'conflicting metadata cannot authenticate an outcome');
      if (view.kind !== 'mcp') assert.fail('conflicting MCP must retain safe MCP rendering');
      assert.equal(view.args, undefined);
      assert.equal(view.result, undefined);
      assert.equal(view.browserActivity, undefined);
      assert.equal(JSON.stringify([view, describeTool(part, en => en)]).includes('PRIVATE'), false);
      if (conflict.native.startsWith('mcp__foreign__')) assert.equal(view.server, undefined);
    }
  }
});

test('shared history bodies and labels protect all managed reads and actions without changing foreign tools', () => {
  for (const tool of ['browser_list_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console_messages', ...actions]) {
    for (const inverse of [false, true]) {
      const part = { type: 'tool', toolName: `mcp__${inverse ? 'PRIVATE' : 'threadterm'}__${tool}`, text: 'PRIVATE echo',
        data: { server: inverse ? 'threadterm' : 'PRIVATE', tool: inverse ? tool : 'PRIVATE', result: 'PRIVATE', images: ['PRIVATE'] },
      } as ChatPart;
      assert.equal(partBody(part), '');
      assert.equal(partLabel(part, en => en), inverse ? 'Browser tool' : tool);
      assert.equal(JSON.stringify([partBody(part), partLabel(part, en => en)]).includes('PRIVATE'), false);
    }
    const outcome = actions.includes(tool) ? 'outcome_unknown' : 'completed';
    const valid = { type: 'tool', toolName: `mcp__threadterm__${tool}`, data: {
      browserActivity: { ...receipt, tool, outcome }, result: 'PRIVATE', input: { text: 'PRIVATE', code: 'PRIVATE', values: ['PRIVATE'] },
    } } as ChatPart;
    assert.match(partBody(valid), /example.test/);
    assert.equal(JSON.parse(partBody(valid)).outcome, outcome);
    assert.equal(partBody(valid).includes('PRIVATE'), false);
  }
  assert.equal(partBody({ type: 'tool', toolName: 'mcp__foreign__read', text: 'ordinary' }), 'ordinary');
});
