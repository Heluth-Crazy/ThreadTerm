import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionState, sessionStateLabel } from '../renderer/src/sessionState.ts';

test('runtime statuses map onto the five presentation states', () => {
  assert.equal(sessionState({ status: 'waiting' }), 'needs');
  assert.equal(sessionState({ status: 'error' }), 'failed');
  assert.equal(sessionState({ status: 'interrupted' }), 'stalled');
  assert.equal(sessionState({ status: 'exited' }), 'ended');
  for (const status of ['starting', 'running', 'idle']) assert.equal(sessionState({ status }), 'running');
  assert.equal(sessionState({ status: 'running', readOnly: true }), 'ended', 'a read-only record is never live');
});

test('state labels are words in both locales, never raw status codes', () => {
  for (const status of ['starting', 'running', 'idle', 'waiting', 'exited', 'interrupted', 'error']) {
    for (const zh of [false, true]) {
      const label = sessionStateLabel(sessionState({ status }), zh);
      assert.notEqual(label, status);
      assert.match(label, zh ? /[一-鿿]/ : /^[A-Z]/);
    }
  }
  assert.equal(sessionStateLabel('stalled', false), 'Stalled');
  assert.equal(sessionStateLabel('needs', true), '需要你');
  assert.equal(sessionStateLabel('ended', false, true), 'Read-only');
});
