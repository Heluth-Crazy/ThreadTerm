import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backgroundShape, panelBorder, tabShape } from './appearance/backgroundGeometry';

test('background placement spans the panel and selected tab without changing the panel origin', () => {
  const panel = { x: 120.5, y: 80.25, w: 400, h: 300 };
  const shape = backgroundShape(panel, { x: 150.5, y: 48.25, w: 200, h: 33 });
  assert.deepEqual(shape.box, { x: 120.5, y: 48.25, w: 400, h: 332 });
  assert.equal(shape.cutLeft, 22);
  assert.equal(shape.cutRight, 238);
  assert.ok(shape.feet.includes('A 8 8'));
  assert.ok(tabShape(shape).endsWith('Z'));
  const border = panelBorder(shape);
  assert.ok(border.startsWith('M 520 88.25 V'));
  assert.ok(border.endsWith('V 88.25'));
  assert.doesNotMatch(border, /80\.75 H/, 'tabbed panel has no top border beside the selected tab');
});

test('a clipped or scrolled tab cannot cut the panel side borders', () => {
  const panel = { x: 100, y: 80, w: 200, h: 300 };
  const shape = backgroundShape(panel, { x: 50, y: 48, w: 400, h: 33 });
  assert.equal(shape.cutLeft, 0);
  assert.equal(shape.cutRight, panel.w);
  assert.deepEqual(shape.tab, { x: 108, y: 48, w: 184, h: 33 });
  assert.equal(backgroundShape(panel, { x: 500, y: 48, w: 60, h: 33 }).tab, undefined);
});

test('a panel without a selected tab has no cut and no feet', () => {
  const panel = { x: 0, y: 0, w: 220, h: 500 };
  const shape = backgroundShape(panel);
  assert.deepEqual(shape.box, panel);
  assert.ok(shape.cutRight < 0);
  assert.equal(shape.feet, '');
  assert.equal(tabShape(shape), '');
  const border = panelBorder(shape);
  assert.ok(border.startsWith('M 8 0.5 H'), 'untabbed panels retain their top hairline');
  assert.ok(border.endsWith('8 0.5'), 'untabbed top-left corner closes into the top hairline');
});
