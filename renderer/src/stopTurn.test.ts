import assert from 'node:assert/strict';
import test from 'node:test';
import { stopFailureMessage } from './stopTurn';

const copy = (en: string, zh: string) => en;

test('only a refused Stop earns an error bar: an ended turn succeeds and other failures stay quiet', () => {
  const refused = new Error("Error invoking remote method 'chat.cancel': Error: turn_not_active: that turn already ended; a newer turn is still running. / turn_not_active：该回合已结束，当前运行的是更新的回合。");
  assert.equal(stopFailureMessage(refused, copy), 'That turn already ended; the newer turn keeps running.');
  assert.equal(stopFailureMessage({ code: 'turn_not_active', message: 'turn_not_active' }, copy), 'That turn already ended; the newer turn keeps running.');
  // A Stop of an already finished turn is now a success: nothing to show.
  assert.equal(stopFailureMessage('', copy), undefined);
  // Connection losses have their own banner.
  assert.equal(stopFailureMessage(new Error("Error invoking remote method 'chat.cancel': Error: Runtime pipe closed"), copy), undefined);
  assert.equal(stopFailureMessage(new Error('provider_disconnected'), copy), undefined);
  assert.equal(stopFailureMessage(refused, (_en, zh) => zh), '该回合已结束，正在运行的是新的回合。');
});
