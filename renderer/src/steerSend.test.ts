import assert from 'node:assert/strict';
import test from 'node:test';
import { steerControlKind, steerFailureMessage } from './steerSend';

const copy = (en: string, zh: string) => en;

test('split send is only the native steer control while a turn is running', () => {
  assert.equal(steerControlKind(true, 'native', true), 'split');
  assert.equal(steerControlKind(false, 'native', false), 'send');
  assert.equal(steerControlKind(false, 'native', true), 'queue');
  assert.equal(steerControlKind(true, undefined, true), 'queue');
  assert.equal(steerControlKind(true, 'note', true), 'queue');
});

test('turn_changed keeps the bilingual sentence and other failures stay visible', () => {
  const ended = new Error("Error invoking remote method 'chat.steer': Error: The turn ended before the message was inserted");
  assert.equal(steerFailureMessage(ended, copy), 'The turn ended before the message was inserted');
  assert.equal(steerFailureMessage({ code: 'turn_changed', message: 'turn_changed' }, copy), 'The turn ended before the message was inserted');
  assert.equal(steerFailureMessage(new Error("Error invoking remote method 'chat.steer': Error: provider_timeout"), copy), 'provider_timeout');
  assert.equal(steerFailureMessage('', (_en, zh) => zh), '消息未能插入。');
});
