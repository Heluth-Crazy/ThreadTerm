import test from 'node:test';
import assert from 'node:assert/strict';
import { paletteKeyAction } from './paletteKeys';

test('an IME composition owns every palette navigation key', () => {
  for (const key of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'Tab']) {
    assert.equal(paletteKeyAction({ key, isComposing: true }), 'ignore', `${key} confirms a candidate, it must not act`);
    assert.equal(paletteKeyAction({ key, isComposing: false, keyCode: 229 }), 'ignore', `${key} with the IME key code must not act`);
  }
});

test('a settled key still drives the palette', () => {
  assert.equal(paletteKeyAction({ key: 'Enter', isComposing: false }), 'run');
  assert.equal(paletteKeyAction({ key: 'Escape', isComposing: false }), 'close');
  assert.equal(paletteKeyAction({ key: 'ArrowDown', isComposing: false }), 'next');
  assert.equal(paletteKeyAction({ key: 'ArrowUp', isComposing: false }), 'previous');
  assert.equal(paletteKeyAction({ key: 'Tab', isComposing: false }), undefined);
  assert.equal(paletteKeyAction({ key: 'a', isComposing: false }), undefined);
});

test('a composing keystroke that is not navigation is left to the input', () => {
  assert.equal(paletteKeyAction({ key: 'a', isComposing: true }), undefined);
  assert.equal(paletteKeyAction({ key: 'Process', keyCode: 229 }), undefined);
});
