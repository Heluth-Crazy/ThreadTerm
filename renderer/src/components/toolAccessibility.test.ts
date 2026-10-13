import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.edge';
import { JsonTree } from './JsonTree';
import { ToolCard } from './ToolCards';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const copy = (en: string) => en;

test('JSON uses contextual disclosures rather than an incomplete ARIA tree', () => {
  const html = renderToStaticMarkup(createElement(JsonTree, { value: { args: { nested: { answer: 42 } } }, copy }));
  assert.doesNotMatch(html, /role="tree(?:item)?"|aria-level=/);
  assert.match(html, /aria-expanded="true" aria-label="Collapse \$"/);
  assert.match(html, /aria-expanded="false" aria-label="Expand \$\.args\.nested"/);
});

test('each tool card is a list item even before its body is opened', () => {
  for (const open of [false, true]) {
    const html = renderToStaticMarkup(createElement(ToolCard, { entry: { id: 'tool', itemId: 'item', part: { type: 'tool', toolId: 'read', toolName: 'Read', status: 'complete', data: { input: { file_path: 'src/app.ts' } } } }, index: 0, open, active: false, awaitingApproval: false, copy }));
    assert.match(html, /^<div role="listitem"/);
  }
});

test('typed-card row gaps use the shared spacing scale', () => {
  const css = readFileSync(resolve('renderer/src/components/tool-activity.css'), 'utf8').split('/* Typed tool cards (B2) */')[1]!;
  const gaps = [...css.matchAll(/\bgap:\s*(\d+)px/g)].map(match => Number(match[1]));
  assert.ok(gaps.length >= 3);
  assert.ok(gaps.every(gap => [4, 6, 8, 12].includes(gap)), `nonstandard typed-card gaps: ${gaps.join(', ')}`);
});
