import assert from 'node:assert/strict';
import test from 'node:test';
import { caretColorForSurface, caretContrast, parseCaretColor } from './editorCaret';

test('caret parser accepts browser-computed RGB and theme hex colours', () => {
  assert.deepEqual(parseCaretColor('rgb(12, 34, 56)'), [12, 34, 56]);
  assert.deepEqual(parseCaretColor('#aBcD01'), [171, 205, 1]);
  assert.equal(parseCaretColor('transparent'), undefined);
});

test('caret color remains at least 3:1 against light, dark and adverse custom surfaces', () => {
  for (const [surface, text] of [
    ['#fefdfb', '#23221f'],
    ['#2c2c2a', '#ecebe5'],
    ['#777777', '#777777'],
  ]) {
    const caret = caretColorForSurface(surface, text);
    assert.ok(caretContrast(parseCaretColor(surface)!, parseCaretColor(caret)!) >= 3, `${surface}/${text}`);
  }
});
