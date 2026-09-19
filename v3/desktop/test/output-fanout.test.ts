import assert from 'node:assert/strict';
import test from 'node:test';
import { OutputFanout } from '../src/output-fanout.js';

const chunk = { sessionId: 's', cursor: 0, data: new Uint8Array([1]) };
test('one upstream chunk waits for every same-session consumer acknowledgement', async () => {
  const fanout = new OutputFanout(); let release!: () => void; let fast = 0;
  fanout.add('fast', () => { fast++; });
  fanout.add('slow', () => new Promise<void>((resolve) => { release = resolve; }));
  let paid = false; const delivery = fanout.publish(chunk).then(() => { paid = true; });
  await Promise.resolve(); assert.equal(fast, 1); assert.equal(paid, false);
  release(); await delivery; assert.equal(paid, true);
});
test('unsubscribed owner no longer blocks credits and other owners remain', async () => {
  const fanout = new OutputFanout(); let other = 0;
  const remove = fanout.add('dead', () => new Promise<void>(() => undefined));
  fanout.add('other', () => { other++; }); remove(); await fanout.publish(chunk);
  assert.equal(other, 1); assert.equal(fanout.size, 1);
});
