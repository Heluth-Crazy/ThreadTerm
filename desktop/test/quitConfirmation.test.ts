import assert from 'node:assert/strict';
import test from 'node:test';
import { quitConfirmationPreapproved } from '../src/quitConfirmation';

test('only the explicit QA flag pre-approves quitting', () => {
  assert.equal(quitConfirmationPreapproved({ THREADTERM_V3_QA_AUTO_CONFIRM_QUIT: '1' }), true);
  for (const value of [undefined, '', '0', 'true', 'yes', ' 1']) {
    assert.equal(quitConfirmationPreapproved({ THREADTERM_V3_QA_AUTO_CONFIRM_QUIT: value }), false, `value ${JSON.stringify(value)}`);
  }
  assert.equal(quitConfirmationPreapproved({}), false);
});
