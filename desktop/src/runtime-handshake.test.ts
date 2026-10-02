import assert from 'node:assert/strict';
import test from 'node:test';
import { PROTOCOL_CONTRACT, PROTOCOL_VERSION, protocolIncompatibleReason } from '@threadterm/protocol';

test('new desktop rejects an old daemon challenge before sending auth', () => {
  const reason = protocolIncompatibleReason({ kind: 'challenge', nonce: 'n', protocol: PROTOCOL_VERSION });
  assert.ok(reason);
  assert.match(reason, /left running/);
  assert.doesNotMatch(reason, /kill|terminat|shutdown/i);
});

test('new runtime rejects an old desktop auth payload', () => {
  const reason = protocolIncompatibleReason({ kind: 'auth', clientId: 'c', protocol: PROTOCOL_VERSION, nonce: 'n', hmac: '00' }, 'runtime');
  assert.ok(reason);
  assert.match(reason, /were not stopped/);
});

test('matching contract is accepted', () => {
  assert.equal(protocolIncompatibleReason({
    kind: 'challenge', nonce: 'n', protocol: PROTOCOL_VERSION, contract: PROTOCOL_CONTRACT,
  }), undefined);
});
