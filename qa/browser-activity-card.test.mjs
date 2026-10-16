import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

const require = createRequire(resolve('package.json'));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const code = buildSync({ entryPoints: ['renderer/src/components/ToolCards.tsx'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent' }).outputFiles[0].text;
const module = { exports: {} };
vm.runInNewContext(code, { module, exports: module.exports, require, TextEncoder, URL });
const { ToolCard } = module.exports;
const thumbnail = 'data:image/jpeg;base64,YXBwcm92ZWQtdGh1bWJuYWls';
const rawImage = 'data:image/png;base64,cHJpdmF0ZS1mdWxsLWltYWdl';
const part = { type: 'tool', toolId: 'read-1', toolName: 'mcp__threadterm__browser_screenshot', status: 'completed', data: {
  type: 'mcpToolCall', server: 'threadterm', tool: 'browser_screenshot', resultRedacted: true,
  browserActivity: { tool: 'browser_screenshot', outcome: 'failed', title: '<script>untrusted title</script>', origin: 'https://example.test', callerSessionId: 'chat-a', thumbnail },
  images: [rawImage], result: { content: [{ type: 'text', text: 'PRIVATE READ BODY' }] },
} };
const render = (open, candidate = part) => renderToStaticMarkup(React.createElement(ToolCard, {
  entry: { id: 'entry-1', itemId: 'item-1', part: candidate }, index: 0, open, active: false,
  awaitingApproval: false, copy: en => en,
}));

test('browser cards render only approved previews and keep read failures visible when collapsed', () => {
  const { browserActivity, images, result } = part.data;
  const fallback = { ...part, data: { browserActivity, images, result } };
  for (const candidate of [part, fallback]) for (const open of [true, false]) {
    const html = render(open, candidate);
    assert.equal(html.includes(rawImage), false);
    assert.equal(html.includes('PRIVATE READ BODY'), false);
    assert.match(html, /data-tool-status="failed"/);
    assert.match(html, /Failed/);
    assert.equal(html.includes(thumbnail), open);
    assert.equal(html.includes('<script>'), false);
    if (open) { assert.match(html, /&lt;script&gt;untrusted title/); assert.match(html, /https:\/\/example.test/); assert.match(html, /Chat: chat-a/); }
  }
});

test('ordinary tool image attachments keep their existing rendering path', () => {
  const html = render(false, { ...part, toolName: 'mcp__other__read', data: { server: 'other', tool: 'read', images: [rawImage] } });
  assert.equal(html.includes(rawImage), true);
});
