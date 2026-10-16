import assert from 'node:assert/strict';
import test from 'node:test';
import { chatExportUsage, chatMarkdownExport, chatMarkdownExportBundle } from './chatMarkdownExport';
import type { ChatItem } from '@threadterm/protocol';
const meta = { title: '中文 export', provider: 'fixture', model: 'test-model', createdAt: '2026-10-13', durationMs: 1000, tokens: { input: 3, output: 4, total: 7 } };
const items: ChatItem[] = [
  { id: 'u', turnId: 't', role: 'user', createdAt: '', parts: [{ type: 'text', text: '中文 question' }] },
  { id: 'a', turnId: 't', role: 'assistant', createdAt: '', parts: [{ type: 'thinking', text: 'private <thought>' }, { type: 'tool', toolId: 'read', toolName: 'Read', data: { file_path: 'src/a.ts' }, status: 'complete' }, { type: 'text', text: '```ts\nconst s = "```";\n```\n中文 answer', data: { images: ['data:image/png;base64,AAAA', { path: 'images/chart.png' }] } }] },
];
test('export preserves Chinese/code Markdown, header metadata and one B3 summary per turn', () => {
  const markdown = chatMarkdownExport(items, meta);
  assert.match(markdown, /中文 question/); assert.match(markdown, /const s = "```";/);
  assert.match(markdown, /test-model/); assert.match(markdown, /total 7/);
  assert.equal(markdown.match(/Tool activity:/g)?.length, 1);
  assert.match(markdown, /<details>/); assert.match(markdown, /src\/a.ts/);
  assert.doesNotMatch(markdown, /private|base64|AAAA/); assert.match(markdown, /images\/chart.png/);
});
test('thinking is opt-in and inert inside details, and tool HTML is escaped', () => {
  const markdown = chatMarkdownExport(items, { ...meta, includeThinking: true, locale: 'zh-CN' });
  assert.match(markdown, /private &lt;thought&gt;/); assert.match(markdown, /工具执行/);
});
test('very long exports accumulate linearly without losing ordered messages', () => {
  const long: ChatItem[] = Array.from({ length: 20000 }, (_, i) => ({ id: String(i), turnId: String(i), role: i % 2 ? 'assistant' : 'user', createdAt: '', parts: [{ type: 'text', text: `${i} ${'x'.repeat(100)}` }] }));
  const start = performance.now(), markdown = chatMarkdownExport(long, meta);
  assert.ok(markdown.indexOf('0 xxx') < markdown.indexOf('19999 xxx'));
  assert.ok(markdown.length > 2000000); assert.ok(performance.now() - start < 2000);
});
test('export aggregates all per-turn usage and keeps missing counters unknown', () => {
  const records = [
    { sessionId: 's', provider: 'codex' as const, recordedAt: '1', inputTokens: 10, outputTokens: 3, model: 'first' },
    { sessionId: 's', provider: 'codex' as const, recordedAt: '2', inputTokens: 20, outputTokens: 4, model: 'latest' },
    { sessionId: 'other', provider: 'codex' as const, recordedAt: '3', inputTokens: 999, outputTokens: 999 },
  ];
  assert.deepEqual(chatExportUsage(records, 's'), { model: 'latest', tokens: { input: 30, output: 7, total: 37 } });
  assert.equal(chatExportUsage([...records, { sessionId: 's', provider: 'codex', recordedAt: '4', outputTokens: 2 }], 's').tokens?.input, undefined);
});
test('pasted images are deterministic companion references, deduplicated across text and attachments', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const jpeg = 'data:image/jpeg;base64,/9j/';
  const imageItems: ChatItem[] = [{ id: 'i', role: 'user', createdAt: '', parts: [{ type: 'text', text: `中文 ![inline](<${png}>)`, data: { images: [png, jpeg, png, { path: 'local/chart.png' }] } }] }];
  const bundle = chatMarkdownExportBundle(imageItems, meta, 'token');
  assert.deepEqual(bundle.images, [{ name: 'image-1.png', dataUrl: png }, { name: 'image-2.jpeg', dataUrl: jpeg }]);
  assert.equal(bundle.markdown.match(/<token\/image-1.png>/g)?.length, 3);
  assert.match(bundle.markdown, /<token\/image-2.jpeg>/); assert.match(bundle.markdown, /local\/chart.png/);
  assert.doesNotMatch(bundle.markdown, /base64|iVBOR/);
});
test('export token collisions and excessive asset counts fail before saving', () => {
  assert.throws(() => chatMarkdownExportBundle(items, meta, '中文'), /collision/);
  const images = Array.from({ length: 1001 }, (_, i) => `data:image/png;base64,${btoa(`image-${i}`)}`);
  const input: ChatItem[] = [{ id: 'i', role: 'user', createdAt: '', parts: [{ type: 'text', data: { images } }] }];
  assert.throws(() => chatMarkdownExportBundle(input, meta, 'token'), /Too many/);
});
test('export images cover non-text attachments and reject active or remote file references', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const input: ChatItem[] = [{ id: 'i', role: 'assistant', createdAt: '', parts: [{ type: 'tool', toolName: 'Screenshot', status: 'complete', data: { images: [png, 'C:\\local\\a.jpg', '/local/b.webp', 'local/c.gif', 'local/a.svg', 'file:///a.png', 'ftp://example.com/a.png', 'blob:image.png', 'smb:a.png', 'custom:a.png', '//server/a.png', '\\\\server\\a.png', 'bad\npath.png'] } }] }];
  const bundle = chatMarkdownExportBundle(input, meta, 'token');
  assert.equal(bundle.images.length, 1); assert.match(bundle.markdown, /<token\/image-1.png>/);
  assert.match(bundle.markdown, /C:\\local\\a.jpg/); assert.match(bundle.markdown, /\/local\/b.webp/); assert.match(bundle.markdown, /local\/c.gif/);
  assert.doesNotMatch(bundle.markdown, /file:|ftp:|blob:|smb:|custom:|server|\.svg|bad\npath/);
});


test('managed browser exports omit raw images and paths even with contradictory identities or missing receipts', () => {
  const png = 'data:image/png;base64,cHJpdmF0ZQ==';
  for (const tool of ['browser_list_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console_messages'])
    for (const inverse of [false, true]) for (const resultRedacted of [undefined, false]) {
      const input: ChatItem[] = [{ id: 'private', role: 'assistant', createdAt: '', parts: [{
        type: 'tool', toolName: `mcp__${inverse ? 'foreign' : 'threadterm'}__${tool}`, status: 'completed',
        text: 'PRIVATE echo', fileReferences: [{ path: 'D:/PRIVATE.png' }], data: {
          server: inverse ? 'threadterm' : 'PRIVATE SERVER', tool: inverse ? tool : 'PRIVATE TOOL', resultRedacted,
          images: [png, 'D:/PRIVATE.png'], result: 'PRIVATE', input: { text: 'PRIVATE' },
        },
      }] }];
      const original = JSON.stringify(input);
      const bundle = chatMarkdownExportBundle(input, meta, 'assets');
      assert.deepEqual(bundle.images, []);
      assert.doesNotMatch(bundle.markdown, /PRIVATE|base64|image-1/);
      assert.doesNotMatch(chatMarkdownExport(input, meta, new Map([[png, 'PRIVATE/asset.png']])), /PRIVATE|base64/);
      assert.equal(JSON.stringify(input), original);
    }
  const ordinary: ChatItem[] = [{ id: 'ordinary', role: 'assistant', createdAt: '', parts: [{
    type: 'tool', toolName: 'mcp__foreign__browser_snapshot', data: { server: 'foreign', tool: 'browser_snapshot', images: [png, 'D:/ordinary.png'] },
  }] }];
  const bundle = chatMarkdownExportBundle(ordinary, meta, 'assets');
  assert.equal(bundle.images.length, 1);
  assert.match(bundle.markdown, /ordinary.png/);
});
