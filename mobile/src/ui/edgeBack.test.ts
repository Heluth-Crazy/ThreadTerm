import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldFinishEdgeBack, shouldStartEdgeBack } from './edgeBack';

test('only a single rightward horizontal gesture from the leading edge starts Back', () => {
  assert.equal(shouldStartEdgeBack(12, 20, 3, 1), true);
  for (const [x, dx, dy, touches] of [[25, 100, 0, 1], [-1, 100, 0, 1], [8, -40, 0, 1], [8, 10, 30, 1], [8, 30, 0, 2], [8, 4, 0, 1]]) {
    assert.equal(shouldStartEdgeBack(x, dx, dy, touches), false);
  }
});

test('Back commits by distance or deliberate flick, cancels short, slow or reversed drags', () => {
  assert.equal(shouldFinishEdgeBack(140, 0, 390), true);
  assert.equal(shouldFinishEdgeBack(35, 0.6, 390), true);
  assert.equal(shouldFinishEdgeBack(35, 0.1, 390), false);
  assert.equal(shouldFinishEdgeBack(15, 1, 390), false);
  assert.equal(shouldFinishEdgeBack(200, -0.5, 390), false);
  assert.equal(shouldFinishEdgeBack(140, 0, 844), false, 'rotation uses current surface width');
});
