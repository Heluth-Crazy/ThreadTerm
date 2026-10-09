import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '@threadterm/protocol';
import { presentedSession } from './resumedSession';

const before: Session = {id:'imported',title:'Imported',provider:'codex',mode:'chat',status:'idle',readOnly:true,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00.123000000Z'};
const resumed = {...before,readOnly:false,updatedAt:'2026-01-01T00:00:00.123000100Z'};

test('resume reply supplies interactive state before a snapshot or event arrives',()=>{
  assert.equal(presentedSession(before,resumed),resumed);
  assert.equal(presentedSession({...before},resumed),resumed,'a copied stale row is still stale');
  assert.equal(presentedSession({...before,id:'other'},resumed).id,'other');
});

test('fresh canonical snapshots supersede the handoff including later read-only state',()=>{
  const newer={...before,updatedAt:'2026-01-01T00:00:00.123000200Z'};
  assert.equal(presentedSession(newer,resumed),newer,'nanosecond ordering must survive Date millisecond precision');
  const ready: Session={...resumed,status:'running'};
  assert.equal(presentedSession(ready,resumed),ready);
  const equivalent: Session={...ready,updatedAt:'2026-01-01T00:00:00.123000100+00:00'};
  assert.equal(presentedSession(equivalent,resumed),equivalent);
});
