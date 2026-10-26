import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backgroundShape, panelBorder, tabBorder, tabShape } from './appearance/backgroundGeometry';

test('background placement spans the panel and selected tab without changing the panel origin', () => {
  const panel = { x: 120.5, y: 80.25, w: 400, h: 300 };
  const shape = backgroundShape(panel, { x: 150.5, y: 48.25, w: 200, h: 33 });
  assert.deepEqual(shape.box, { x: 120.5, y: 48.25, w: 400, h: 332 });
  assert.equal(shape.cutLeft, 22);
  assert.equal(shape.cutRight, 238);
  assert.ok(shape.feet.includes('A 8 8'));
  assert.ok(tabShape(shape).endsWith('Z'));
  assert.ok(panelBorder(shape).startsWith('M 358.5 80.75 H'));
  assert.ok(panelBorder(shape).endsWith('H 142.5'));
  const outline = tabBorder(shape);
  assert.ok(outline.startsWith('M 143 80.75 A 8 8'));
  assert.ok(outline.endsWith('358 80.75'));
  assert.equal(outline.endsWith('Z'), false, 'tab outline stays open at the panel join');
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
  assert.equal(tabBorder(shape), '');
});
