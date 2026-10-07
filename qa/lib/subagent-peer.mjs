// Keep the older QA Peer transport/request helpers, but authenticate against
// the repository's current contract rather than its legacy hardcoded value.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { PROTOCOL_CONTRACT } from '../../protocol/index.ts';
import { connectPeer } from '../pipe-client.mjs';

export async function connectSubagentPeer(name) {
  const peer = await connectPeer(name);
  peer.auth = async function (credential, clientId = randomUUID()) {
    const challenge = JSON.parse(await this.next());
    assert.equal(challenge.contract, PROTOCOL_CONTRACT);
    this.json({ kind: 'auth', clientId, protocol: 1, contract: PROTOCOL_CONTRACT, nonce: challenge.nonce,
      hmac: createHmac('sha256', credential).update(`1:${clientId}:${challenge.nonce}`).digest('hex') });
    const proof = JSON.parse(await this.next());
    assert.equal(proof.kind, 'authenticated');
    assert.equal(proof.contract, PROTOCOL_CONTRACT);
    assert.equal(proof.hmac, createHmac('sha256', credential).update(`server:1:${clientId}:${challenge.nonce}`).digest('hex'));
    return clientId;
  };
  return peer;
}
