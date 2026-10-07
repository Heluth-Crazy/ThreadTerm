import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildClipboardItems, clampContextMenu, lineRangeLabel, nextMenuIndex } from './contextMenuActions';

test('menu geometry flips at both viewport edges and clamps oversized panels', () => {
  assert.deepEqual(clampContextMenu(990, 790, 240, 300, 1000, 800), { left: 750, top: 490 });
  assert.deepEqual(clampContextMenu(2, 3, 240, 300, 1000, 800), { left: 8, top: 8 });
  assert.deepEqual(clampContextMenu(10, 10, 1200, 900, 1000, 800), { left: 8, top: 8 });
  assert.deepEqual(clampContextMenu(500, 300, 240, 300, 1000, 800), { left: 500, top: 300 });
});

test('line labels retain endpoints and have English and Chinese copy', () => {
  assert.equal(lineRangeLabel('en', 12, 20), 'lines 12–20');
  assert.equal(lineRangeLabel('zh-CN', 12, 20), '第 12–20 行');
  assert.equal(lineRangeLabel(false, 20, 12), 'lines 12–20');
  assert.equal(lineRangeLabel(true, 12, 12), '第 12 行');
});

test('clipboard builder keeps disabled actions with reasons and gates edits', () => {
  const noop = () => {};
  const items = buildClipboardItems({ language: 'en', hasSelection: false, editable: false, copy: noop, cut: noop, paste: noop, selectAll: noop });
  assert.deepEqual(items.map(item => item.id), ['cut', 'copy', 'paste', 'select-all']);
  const byId = (id: string) => items.find(item => item.id === id)!;
  assert.equal(byId('copy').disabled, true);
  assert.equal(byId('copy').reason, 'Select text first.');
  assert.equal(byId('cut').reason, 'This field is read-only.');
  assert.equal(items[2].disabled, true);
  assert.equal(items[3].disabled, undefined);
  const selected = buildClipboardItems({ language: 'zh-CN', hasSelection: true, editable: true, copy: noop, cut: noop, paste: noop });
  assert.deepEqual(selected.map(item => item.label), ['剪切', '复制', '粘贴']);
  assert.ok(selected.every(item => !item.disabled));
});

test('menu keyboard traversal wraps enabled items and handles missing focus', () => {
  assert.equal(nextMenuIndex('ArrowUp', 0, 3), 2);
  assert.equal(nextMenuIndex('ArrowDown', 2, 3), 0);
  assert.equal(nextMenuIndex('Home', 2, 3), 0);
  assert.equal(nextMenuIndex('End', 0, 3), 2);
  assert.equal(nextMenuIndex('ArrowUp', -1, 3), 2);
  assert.equal(nextMenuIndex('ArrowDown', -1, 3), 0);
  assert.equal(nextMenuIndex('Home', -1, 0), -1);
});
