import test from 'node:test';
import assert from 'node:assert/strict';
import { isComposingKey, slashPaletteEnter } from './composeKeys';

test('an IME confirm never runs a slash-palette entry', () => {
  assert.equal(slashPaletteEnter({ key: 'Enter', shiftKey: false, isComposing: false }), true);
  assert.equal(slashPaletteEnter({ key: 'Enter', shiftKey: false, isComposing: true }), false);
  assert.equal(slashPaletteEnter({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 }), false);
  assert.equal(slashPaletteEnter({ key: 'Enter', shiftKey: true, isComposing: false }), false);
  assert.equal(slashPaletteEnter({ key: 'a', shiftKey: false, isComposing: false }), false);
});

test('the shared composing guard covers both IME signals', () => {
  assert.equal(isComposingKey({ isComposing: true }), true);
  assert.equal(isComposingKey({ keyCode: 229 }), true);
  assert.equal(isComposingKey({ isComposing: false, keyCode: 13 }), false);
  assert.equal(isComposingKey({}), false);
});
