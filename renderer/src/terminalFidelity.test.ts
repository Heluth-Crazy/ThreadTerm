import test from 'node:test';
import assert from 'node:assert/strict';
import { EXACT, fidelityAfterLiveGap, screenFidelityDetail, screenFidelityLabel } from './terminalFidelity';

test('a live gap makes an exact screen inexact', () => {
  assert.deepEqual(EXACT, { kind: 'exact' });
  assert.deepEqual(fidelityAfterLiveGap(EXACT, 4096), { kind: 'inexact', fromCursor: 4096, reason: 'output-gap' });
});

test('the first gap cursor is kept and later gaps do not reset it', () => {
  const first = fidelityAfterLiveGap(EXACT, 100);
  assert.deepEqual(first, { kind: 'inexact', fromCursor: 100, reason: 'output-gap' });
  assert.deepEqual(fidelityAfterLiveGap(first, 900), first);
  assert.deepEqual(fidelityAfterLiveGap(fidelityAfterLiveGap(first, 900), 4000), first);
});

test('the gap helper never recovers by itself; only a new replay starts exact', () => {
  // The surface resets by assigning EXACT when a full replay starts, so even a
  // cursor back at zero stays inexact here.
  assert.equal(fidelityAfterLiveGap(EXACT, 0).kind, 'inexact');
  assert.equal(EXACT.kind, 'exact');
});

test('both locales label the inexact screen and explain it without jargon', () => {
  for (const zh of [true, false]) {
    assert.ok(screenFidelityLabel(zh).length > 1);
    assert.ok(screenFidelityDetail(zh).length > 30);
  }
  assert.equal(screenFidelityLabel(false), 'Screen may be inaccurate');
  assert.equal(screenFidelityLabel(true), '画面可能不准确');
  assert.notEqual(screenFidelityLabel(true), screenFidelityLabel(false));
  assert.notEqual(screenFidelityDetail(true), screenFidelityDetail(false));
});
