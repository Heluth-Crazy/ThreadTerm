import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSafeCssValue,
  isScopedSelector,
  sanitizeCssRules,
  sanitizeDeclarationText,
  stripMermaidDirectives,
} from './ChatMarkdownExtras/mermaidSafety';

// Node has no jsdom/happy-dom and no CSSOM, so the browser-only pieces
// (`safeMermaidSvg`, `sanitizeCssText`) are covered by the Electron visual QA.
// Everything the allowlist decides is a pure function and is tested here.

test('mermaid directives and frontmatter config are stripped before rendering', () => {
  const frontmatter = '---\nconfig:\n  themeCSS: ".x { background-image: image-set(\\"https://evil.invalid/x\\") }"\n---\ngraph TD; A-->B';
  assert.equal(stripMermaidDirectives(frontmatter), 'graph TD; A-->B');
  assert.equal(stripMermaidDirectives('%%{init: {"themeCSS": ".x { color: red }"}}%%\ngraph TD'), 'graph TD');
  assert.equal(stripMermaidDirectives('graph TD; A-->B'), 'graph TD; A-->B');
});

test('css values allow only colour/var functions and local fragments', () => {
  for (const safe of ['#fff', 'red', 'rgb(1, 2, 3)', 'rgba(0, 0, 0, .5)', 'hsl(1 2% 3%)', 'var(--ttm-text)', 'url(#gradient-a)', '2px dashed']) {
    assert.equal(isSafeCssValue(safe), true, safe);
  }
  for (const hostile of [
    'image-set("https://evil.invalid/x")',
    '-webkit-image-set("//evil.invalid/x")',
    'cross-fade(url(https://evil.invalid/x))',
    'paint(evil)',
    'url(https://evil.invalid/x)',
    'url(//evil.invalid/x)',
    'url(data:image/png;base64,AAAA)',
    'expression(alert(1))',
    'url(#a) image-set("https://evil.invalid/x")',
    'red} * {position: fixed',
  ]) {
    assert.equal(isSafeCssValue(hostile), false, hostile);
  }
});

test('style rules must be scoped to the rendered diagram id', () => {
  assert.equal(isScopedSelector('#ttmermaid1 .node', '#ttmermaid1'), true);
  assert.equal(isScopedSelector('#ttmermaid1', '#ttmermaid1'), true);
  assert.equal(isScopedSelector('*', '#ttmermaid1'), false);
  assert.equal(isScopedSelector('.node', '#ttmermaid1'), false);
  assert.equal(isScopedSelector('#ttmermaid10 .node', '#ttmermaid1'), false);
  // A comma-separated list is split by the caller; `isScopedSelector` sees one selector.
  assert.equal(isScopedSelector('#ttmermaid1, .leak', '#ttmermaid1'), true);
  // Sibling combinators and :has() reach outside the diagram's subtree.
  assert.equal(isScopedSelector('#ttmermaid1 ~ *', '#ttmermaid1'), false);
  assert.equal(isScopedSelector('#ttmermaid1 + *', '#ttmermaid1'), false);
  assert.equal(isScopedSelector('#ttmermaid1 .node ~ .other', '#ttmermaid1'), false);
  assert.equal(isScopedSelector('#ttmermaid1 + .leak', '#ttmermaid1'), false);
  assert.equal(isScopedSelector('#ttmermaid1:has(.node)', '#ttmermaid1'), false);
  assert.equal(isScopedSelector('#ttmermaid1:has(> .node)', '#ttmermaid1'), false);
  // Attribute matching and an nth-child argument are not combinators.
  assert.equal(isScopedSelector('#ttmermaid1[class~="node"]', '#ttmermaid1'), true);
  assert.equal(isScopedSelector('#ttmermaid1:nth-child(2n+1)', '#ttmermaid1'), true);
});

test('style attributes keep only allowlisted declarations', () => {
  assert.equal(
    sanitizeDeclarationText('fill: #f00; background-image: image-set("https://evil.invalid/x")'),
    'fill: #f00',
  );
  assert.equal(sanitizeDeclarationText('stroke: url(https://evil.invalid/x)'), '');
  assert.equal(sanitizeDeclarationText('position: fixed; inset: 0; z-index: 9'), '');
  assert.equal(
    sanitizeDeclarationText('marker-end: url(#arrow); font-family: "Noto Sans"; fill-opacity: .4'),
    'marker-end: url(#arrow); font-family: "Noto Sans"; fill-opacity: .4',
  );
});

test('stylesheet allowlist drops unscoped overlays, remote images and imported sheets', () => {
  const rules = [
    { selectorText: '*', declarations: 'position: fixed; inset: 0; z-index: 999999' },
    { selectorText: '#ttmermaid1 .node', declarations: 'fill: #ffe; stroke: #333; background-image: image-set("https://evil.invalid/x")' },
    { selectorText: '#ttmermaid1 .leak', declarations: 'fill: url(https://evil.invalid/x)' },
    { selectorText: '#ttmermaid10', declarations: 'fill: red' },
    { selectorText: '#ttmermaid1 .ok', declarations: 'fill: var(--ttm-accent); stroke-width: 2px' },
    { selectorText: '#ttmermaid1, .leak', declarations: 'fill: red' },
    { selectorText: '#ttmermaid1 ~ *', declarations: 'position: fixed; inset: 0' },
    { selectorText: '#ttmermaid1 + .leak', declarations: 'fill: red' },
    { selectorText: '#ttmermaid1:has(.leak)', declarations: 'fill: red' },
  ];
  const clean = sanitizeCssRules(rules, '#ttmermaid1');
  assert.doesNotMatch(clean, /position|image-set|https?:|ttmermaid10|~|\+|:has/i);
  assert.match(clean, /#ttmermaid1 \.node \{ fill: #ffe; stroke: #333 \}/);
  assert.match(clean, /#ttmermaid1 \.ok \{ fill: var\(--ttm-accent\); stroke-width: 2px \}/);
});
