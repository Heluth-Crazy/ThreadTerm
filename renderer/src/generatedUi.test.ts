import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGeneratedUi } from './generatedUi';
import { createElement } from 'react';
import { createRequire } from 'node:module';
Object.assign(globalThis, { require: createRequire(import.meta.url) });
const { renderToStaticMarkup } = await import('react-dom/server');
import GeneratedUi from './components/ChatMarkdownExtras/GeneratedUi';
import { SettingsChatTools } from './components/SettingsChatTools';
const components = [
  { type: 'card', title: 'Card', children: [{ type: 'stat', label: 'Nested', value: 1 }] },
  { type: 'stat', label: 'Count', value: '3' }, { type: 'table', columns: ['Name'], rows: [['中文']] },
  { type: 'list', items: ['One'] }, { type: 'badge', text: 'Done', tone: 'success' },
  { type: 'progress', label: 'Complete', value: 50 },
  ...['bar', 'line', 'pie'].map(kind => ({ type: 'chart', kind, data: [{ label: 'Value', value: 3 }] })),
];
test('every component and optional insertion text validates and renders inertly', () => {
  const source = JSON.stringify({ version: 1, components, buttons: [{ label: 'Quote', text: '<script>text only</script>' }] });
  assert.ok(parseGeneratedUi(source).spec);
  const html = renderToStaticMarkup(createElement(GeneratedUi, { kind: 'threadterm-ui', source, copy: en => en, onInsert: () => {} }));
  assert.match(html, /中文/); assert.match(html, /role="progressbar"/); assert.equal(html.match(/<svg/g)?.length, 3);
  assert.doesNotMatch(html, /<script|onclick=|https?:\/\//i);
});
test('unknown types/properties, nested bombs, actions and invalid dimensions fail closed', () => {
  for (const component of [{ type: 'script', src: 'https://invalid.example' }, { type: 'card', onClick: 'evil()' }, { type: 'progress', value: -1 }, { type: 'table', columns: ['a'], rows: [[1, 2]] }, { type: 'chart', kind: 'pie', data: [{ label: 'a', value: -1 }] }]) assert.ok(parseGeneratedUi(JSON.stringify({ version: 1, components: [component] })).error);
  let nested: unknown = { type: 'stat', label: 'a', value: 1 }; for (let i = 0; i < 20; i++) nested = { type: 'card', children: [nested] };
  assert.ok(parseGeneratedUi(JSON.stringify({ version: 1, components: [nested] })).error); assert.ok(parseGeneratedUi('x'.repeat(65537)).error);
});
test('fuzzed/malformed JSON never escapes as an exception', () => {
  let seed = 123; for (let i = 0; i < 1000; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; assert.doesNotThrow(() => parseGeneratedUi(String.fromCharCode(seed % 127) + JSON.stringify({ [String(seed)]: seed }))); }
});
test('generated instructions default off while rendering remains available', () => {
  const html = renderToStaticMarkup(createElement(SettingsChatTools, { settings: { revision: 0 }, zh: false, update: async () => {} }));
  assert.match(html, /data-testid="generated-ui-switch"/); assert.match(html, /Generated UI/); assert.match(html, /aria-checked="false"/); assert.match(html, />Off</);
});
