import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatPart } from '@threadterm/protocol';
import { browserToolActivity, browserToolActivityFromPart, browserToolNameFromPart, hasRedactedBrowserResult } from './browserToolActivity';
import { partBody, partLabel } from './chatPresentation';
import { toolView } from './toolView';
import { describeTool, toolOutputPreview, toolStatus } from './toolActivity';

const receipt = { tool: 'browser_snapshot', outcome: 'completed', title: '<script>page title</script>', origin: 'https://example.test', callerSessionId: 'chat-a' };

test('browser receipts preserve bounded provenance and discard every raw sibling', () => {
  const activity = browserToolActivity({ ...receipt, snapshot: 'PRIVATE', result: 'PRIVATE', content: ['PRIVATE'] }, receipt.tool);
  assert.deepEqual(activity, { ...receipt, tabId: undefined, url: undefined, thumbnail: undefined, provenanceUnavailable: undefined });
  assert.equal(JSON.stringify(activity).includes('PRIVATE'), false);
  assert.equal(browserToolActivity({ ...receipt, tool: 'browser_eval' }, 'browser_eval'), undefined);
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

test('conflicting native and data identities always redact without borrowing receipt attribution', () => {
  for (const tool of ['browser_list_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console_messages']) {
    for (const conflict of [
      { native: `mcp__threadterm__${tool}`, server: 'PRIVATE SERVER', tool: 'PRIVATE TOOL', safeTitle: `threadterm: ${tool}` },
      { native: `mcp__threadterm__${tool}`, server: 'threadterm', tool: 'browser_snapshot_extra', safeTitle: `threadterm: ${tool}` },
      { native: `mcp__foreign__${tool}`, server: 'threadterm', tool, safeTitle: 'Browser tool' },
    ]) {
      const part = { type: 'tool', toolName: conflict.native, status: 'completed', data: {
        server: conflict.server, tool: conflict.tool, input: { text: 'PRIVATE', url: 'https://PRIVATE', values: ['PRIVATE'] },
        result: 'PRIVATE', rawOutput: 'PRIVATE', images: ['PRIVATE'],
        browserActivity: { tool, outcome: 'failed', origin: 'https://PRIVATE', title: 'PRIVATE', thumbnail: 'data:image/jpeg;base64,YQ==' },
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


test('managed read identities redact every fallback independently of receipt validity or redaction flags', () => {
  for (const tool of ['browser_list_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console_messages'])
    for (const dataIdentity of [{ server: 'threadterm', tool }, {}])
      for (const resultRedacted of [undefined, false]) for (const outcome of [undefined, 'invalid', 'completed']) {
        const part = { type: 'tool', toolName: `mcp__threadterm__${tool}`, status: 'completed', data: {
          ...dataIdentity, resultRedacted, input: { text: 'PRIVATE' }, result: 'PRIVATE', rawOutput: 'PRIVATE',
          ...(outcome ? { browserActivity: { tool, outcome, origin: 'https://example.test' } } : {}),
        } } as ChatPart;
        assert.equal(hasRedactedBrowserResult(part), true);
        assert.equal(toolOutputPreview(part), undefined);
        assert.equal(JSON.stringify([toolView(part), describeTool(part, en => en)]).includes('PRIVATE'), false);
      }
});


test('shared history body and labels never serialize managed browser fallback payloads', () => {
  for (const tool of ['browser_list_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console_messages'])
    for (const inverse of [false, true]) {
      const part = { type: 'tool', toolName: `mcp__${inverse ? 'PRIVATE' : 'threadterm'}__${tool}`, text: 'PRIVATE echo',
        data: { server: inverse ? 'threadterm' : 'PRIVATE', tool: inverse ? tool : 'PRIVATE', result: 'PRIVATE', images: ['PRIVATE'] },
      } as ChatPart;
      assert.equal(partBody(part), '');
      assert.equal(partLabel(part, en => en), inverse ? 'Browser tool' : tool);
      assert.equal(JSON.stringify([partBody(part), partLabel(part, en => en)]).includes('PRIVATE'), false);
    }
  const valid = { type: 'tool', toolName: 'mcp__threadterm__browser_snapshot', data: { browserActivity: receipt, result: 'PRIVATE' } } as ChatPart;
  assert.match(partBody(valid), /example.test/);
  assert.equal(partBody(valid).includes('PRIVATE'), false);
  assert.equal(partBody({ type: 'tool', toolName: 'mcp__foreign__read', text: 'ordinary' }), 'ordinary');
});
