import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalContextMenuItems } from './terminalContextMenuItems';

const noop = () => {};
test('terminal context menu puts captured target action first and keeps unavailable actions visible', () => {
  const items = terminalContextMenuItems({ zh: false, selection: '', canPaste: false, canSend: false, copy: noop, paste: noop, send: noop, selectAll: noop });
  assert.deepEqual(items.map(item => item.testId), ['terminal-selection-send-to-agent', undefined, 'terminal-context-copy', 'terminal-context-paste', 'terminal-context-select-all']);
  assert.equal(items[0].disabled, true); assert.equal(items[0].reason, 'Open a Chat session in this workspace first.');
  assert.equal(items[2].disabled, true); assert.equal(items[3].disabled, true);
});
test('terminal context menu callbacks use the selection captured before menu focus', async () => {
  let copied = ''; const items = terminalContextMenuItems({ zh: false, selection: 'captured output', canPaste: true, canSend: true, copy: () => { copied = 'captured output'; }, paste: noop, send: noop, selectAll: noop });
  await items[2].onSelect?.(); assert.equal(copied, 'captured output'); assert.equal(items[0].disabled, false);
});
