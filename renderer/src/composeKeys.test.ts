import test from 'node:test';
import assert from 'node:assert/strict';
import { slashPaletteEnter } from './composeKeys';

test('an IME confirm never runs a slash-palette entry', () => {
  assert.equal(slashPaletteEnter({ key: 'Enter', shiftKey: false, isComposing: false }), true);
  assert.equal(slashPaletteEnter({ key: 'Enter', shiftKey: false, isComposing: true }), false);
  assert.equal(slashPaletteEnter({ key: 'Enter', shiftKey: true, isComposing: false }), false);
  assert.equal(slashPaletteEnter({ key: 'a', shiftKey: false, isComposing: false }), false);
});
