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
const render = (open, candidate = part, locale = 'en') => renderToStaticMarkup(React.createElement(ToolCard, {
  entry: { id: 'entry-1', itemId: 'item-1', part: candidate }, index: 0, open, active: false,
  awaitingApproval: false, copy: (en, zh) => locale === 'zh' ? zh : en,
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

test('all action cards suppress raw arguments, native echoes, reference chips and images with or without metadata', () => {
  for (const tool of ['browser_navigate', 'browser_click', 'browser_type', 'browser_hover', 'browser_press_key', 'browser_select_option']) {
    for (const identity of [{ server: 'threadterm', tool }, {}]) for (const withReceipt of [true, false]) for (const open of [true, false]) {
      const candidate = { type: 'tool', toolId: tool, toolName: `mcp__threadterm__${tool}`, status: 'completed', text: 'PRIVATE native echo',
        fileReferences: [{ path: 'D:/PRIVATE.txt', label: 'PRIVATE file reference' }], data: {
          ...identity, input: { text: 'PRIVATE typed value', code: 'PRIVATE executable', values: ['PRIVATE selection'],
            ref: 'PRIVATE ref', url: 'https://example.test/PRIVATE', selector: 'PRIVATE selector', element: 'PRIVATE element' },
          result: { content: [{ type: 'text', text: 'PRIVATE result' }, { type: 'image', data: rawImage }] },
          rawOutput: 'PRIVATE output', rawInput: 'PRIVATE input', images: [rawImage],
          ...(withReceipt ? { browserActivity: { tool, outcome: 'outcome_unknown', title: '<script>approved source title</script>',
            origin: 'https://source.test', thumbnail, text: 'PRIVATE', code: 'PRIVATE', values: ['PRIVATE'] } } : {}),
        } };
      for (const locale of ['en', 'zh']) {
        const html = render(open, candidate, locale);
        assert.equal(html.includes('PRIVATE'), false);
        assert.equal(html.includes(rawImage), false);
        assert.equal(html.includes(thumbnail), false, 'only a screenshot receipt may publish a thumbnail');
        assert.equal(html.includes('<script>'), false);
        if (withReceipt) {
          assert.match(html, /data-tool-status="failed"/);
          assert.match(html, locale === 'zh' ? /操作结果未知/ : /Outcome unknown/);
          assert.equal(html.includes('Completed'), false);
          assert.equal(html.includes('已完成'), false);
          if (open) assert.match(html, /&lt;script&gt;approved source title/);
        }
      }
    }
  }
});

test('authenticated unknown and cancelled outcomes survive native error flags without claiming completion', () => {
  for (const outcome of ['outcome_unknown', 'cancelled']) for (const open of [true, false]) {
    const candidate = { ...part, toolName: 'mcp__threadterm__browser_click', data: { isError: true,
      browserActivity: { tool: 'browser_click', outcome, provenanceUnavailable: true }, result: 'PRIVATE' } };
    const html = render(open, candidate);
    assert.match(html, outcome === 'outcome_unknown' ? /Outcome unknown/ : /Interrupted/);
    assert.equal(html.includes('Completed'), false);
    assert.equal(html.includes('PRIVATE'), false);
    if (open) assert.match(html, /Page provenance unavailable/);
  }
});

test('conflicting identities cannot leak raw header fields or acquire browser metadata through any card sink', () => {
  for (const tool of ['browser_list_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console_messages',
    'browser_navigate', 'browser_click', 'browser_type', 'browser_hover', 'browser_press_key', 'browser_select_option']) {
    for (const inverse of [false, true]) for (const open of [false, true])
      for (const resultRedacted of [undefined, false]) for (const outcome of [undefined, 'invalid', 'outcome_unknown']) {
      const candidate = { type: 'tool', toolName: `mcp__${inverse ? 'foreign' : 'threadterm'}__${tool}`, status: 'completed',
        text: 'PRIVATE native echo', fileReferences: [{ path: 'D:/PRIVATE.txt', label: 'PRIVATE reference' }], data: {
          server: inverse ? 'threadterm' : 'PRIVATE SERVER', tool: inverse ? tool : 'PRIVATE TOOL',
          input: { text: 'PRIVATE typed text', code: 'PRIVATE code', values: ['PRIVATE'], url: 'https://PRIVATE', ref: 'PRIVATE' },
          result: { content: [{ type: 'text', text: 'PRIVATE result' }] }, rawOutput: 'PRIVATE raw output', images: [rawImage],
          resultRedacted,
          ...(outcome ? { browserActivity: { tool, outcome, origin: 'https://PRIVATE', title: 'PRIVATE forged provenance', thumbnail } } : {}),
        } };
      const html = render(open, candidate);
      assert.equal(html.includes('PRIVATE'), false);
      assert.equal(html.includes(rawImage), false);
      assert.equal(html.includes(thumbnail), false);
      assert.equal(html.includes('browser-tool-activity'), false);
      assert.equal(html.includes('Outcome unknown'), false, 'a conflicting receipt cannot authenticate outcome');
      assert.equal(html.includes('threadterm:'), !inverse, 'only canonical managed native identity supplies the header');
    }
  }
});

test('raw feedback metadata cannot bypass any managed browser card', () => {
  for (const tool of ['browser_list_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console_messages',
    'browser_navigate', 'browser_click', 'browser_type', 'browser_hover', 'browser_press_key', 'browser_select_option']) for (const open of [false, true]) {
    const html = render(open, { type: 'tool', toolName: `mcp__threadterm__${tool}`, status: 'completed', data: {
      server: 'threadterm', tool: 'feedback_check', result: { notes: [{ id: 'n', sessionId: 's', turnId: 't', text: 'PRIVATE feedback', status: 'waiting' }] },
    } });
    assert.equal(html.includes('PRIVATE'), false);
    assert.equal(html.includes('Show all'), false);
    assert.match(html, new RegExp(tool));
  }
});

test('actual imported-history transcript protects all managed browser bodies and labels', () => {
  const historyCode = buildSync({ stdin: { contents: `export { HistoryTranscript } from './renderer/src/components/HistoryTranscript'; export { I18nProvider } from './renderer/src/i18n';`, resolveDir: resolve('.') },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, loader: { '.css': 'empty' }, logLevel: 'silent',
  }).outputFiles[0].text;
  const historyModule = { exports: {} };
  vm.runInNewContext(historyCode, { module: historyModule, exports: historyModule.exports, require, TextEncoder, URL });
  const { HistoryTranscript, I18nProvider } = historyModule.exports;
  for (const tool of ['browser_list_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console_messages',
    'browser_navigate', 'browser_click', 'browser_type', 'browser_hover', 'browser_press_key', 'browser_select_option'])
    for (const inverse of [false, true]) for (const locale of ['en', 'zh-CN']) {
      const candidate = { type: 'tool', toolName: `mcp__${inverse ? 'PRIVATE' : 'threadterm'}__${tool}`, text: 'PRIVATE echo', data: {
        server: inverse ? 'threadterm' : 'PRIVATE', tool: inverse ? tool : 'PRIVATE', images: [rawImage], result: 'PRIVATE',
        input: { text: 'PRIVATE', code: 'PRIVATE', values: ['PRIVATE'] },
      } };
      const html = renderToStaticMarkup(React.createElement(I18nProvider, { locale }, React.createElement(HistoryTranscript, {
        items: [{ id: 'history', role: 'assistant', createdAt: '', parts: [candidate] }],
      })));
      assert.equal(html.includes('PRIVATE'), false);
      assert.equal(html.includes(rawImage), false);
      assert.match(html, /history-tool-line/);
    }
  const ordinary = renderToStaticMarkup(React.createElement(I18nProvider, { locale: 'en' }, React.createElement(HistoryTranscript, {
    items: [{ id: 'foreign', role: 'assistant', createdAt: '', parts: [{ type: 'tool', toolName: 'mcp__foreign__read', text: 'ordinary history output' }] }],
  })));
  assert.match(ordinary, /ordinary history output/);
});
