import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLeasePool} from '../renderer/src/controlLease.ts';
test('two panes share one lease and only the final unmount releases it',async()=>{
  let claims=0,releases=0;
  const acquire=createLeasePool({claim:async()=>++claims,renew:async()=>{},release:async()=>{releases++;}});
  const [first,second]=await Promise.all([acquire('session',()=>{}),acquire('session',()=>{})]);
  assert.equal(claims,1); assert.equal(first.epoch,second.epoch);
  first.release(); first.release(); assert.equal(releases,0);
  second.release(); assert.equal(releases,1);
  const third=await acquire('session',()=>{}); assert.equal(claims,2); third.release();
});

test('renew failure drops the dead lease so a later acquire claims again', async () => {
  let claims = 0, releases = 0, lost = 0;
  let failRenew = false;
  const acquire = createLeasePool({
    claim: async () => ++claims,
    renew: async () => { if (failRenew) throw new Error('stale_lease'); },
    release: async () => { releases++; },
  }, 20);
  const first = await acquire('session', () => { lost++; });
  failRenew = true;
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(lost, 1);
  first.release();
  assert.equal(releases, 0);
  const second = await acquire('session', () => {});
  assert.equal(claims, 2);
  second.release();
  assert.equal(releases, 1);
});
