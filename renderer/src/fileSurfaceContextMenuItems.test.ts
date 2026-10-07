import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffSurfaceMenuItems, renderedPreviewMenuItems, sourceEditorMenuItems } from './fileSurfaceContextMenuItems';

const noop = () => {};
const comment = { zh: false, lines: { startLine: 12, endLine: 20 }, canComment: true, comment: noop };
const editor = { ...comment, hasSelection: true, readOnly: false, send: noop, plans: noop, pinned: false, plansDisabled: false, history: noop, copy: noop, cut: noop, paste: noop, selectAll: noop, copyPath: noop, copyReference: noop };

test('source menu targets selected lines, keeps dirty comment target and orders existing actions', () => {
  const items = sourceEditorMenuItems({ ...editor, canComment: false, commentReason: 'Save or discard your edits first: they move the lines.' });
  assert.deepEqual(items.slice(0, 4).map(item => item.label), ['Comment on lines 12–20', 'Send lines 12–20 to agent', 'Add to Plans & docs', 'File history']);
  assert.equal(items[0].disabled, true);
  assert.match(items[0].reason!, /Save or discard/);
  assert.equal(items[4].separator, true);
  assert.deepEqual(items.slice(5).map(item => item.label), ['Cut', 'Copy', 'Paste', 'Select all', 'Copy path', 'Copy reference']);
});

test('caret-only editor sends file and keeps unavailable clipboard and navigation reasons visible', () => {
  const items = sourceEditorMenuItems({ ...editor, hasSelection: false, readOnly: true, send: undefined, history: undefined, plans: undefined, pinned: true });
  assert.equal(items[1].label, 'Send file to agent');
  assert.equal(items[2].label, 'Remove from Plans & docs');
  for (const index of [1, 2, 3, 5, 6, 7]) { assert.equal(items[index].disabled, true); assert.ok(items[index].reason); }
});

test('diff menus expose only comment, supported diff send and captured clipboard actions', () => {
  const diff = diffSurfaceMenuItems({ ...comment, prefix: 'editor', hasSelection: true, sendDiff: noop, copy: noop, copyPath: noop });
  assert.deepEqual(diff.filter(item => !item.separator).map(item => item.label), ['Comment on lines 12–20', 'Send diff to agent', 'Copy', 'Copy path']);
  const review = diffSurfaceMenuItems({ ...comment, prefix: 'review-diff', hasSelection: false, copy: noop, copyPath: noop });
  assert.deepEqual(review.filter(item => !item.separator).map(item => item.testId), ['review-diff-context-comment', 'review-diff-context-copy', 'review-diff-context-copy-path']);
  assert.equal(review[2].disabled, true);
});

test('Markdown and saved HTML share the same file actions and bilingual disabled capabilities', () => {
  const options = { zh: true, hasSelection: false, copy: noop, selectAll: noop };
  const items = renderedPreviewMenuItems(options);
  assert.deepEqual(items.filter(item => !item.separator).map(item => item.label), ['将文件发送给 Agent', '查看源代码', '复制', '全选']);
  for (const index of [0, 1, 3]) { assert.equal(items[index].disabled, true); assert.ok(items[index].reason); }
});
