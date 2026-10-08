import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_REPAIR_REQUEST, chatRepairAvailability, requestChatRepair, setChatRepairAvailability } from './chatRepair';

test('session menu selects one writable view and survives another view unmounting', () => {
  const events: Event[] = [];
  const previous = globalThis.dispatchEvent;
  globalThis.dispatchEvent = event => { events.push(event); return true; };
  const ready = { offered: true, degraded: true, mode: 'rebuild' as const, writable: true };
  try {
    setChatRepairAvailability('multi', 'first', ready);
    setChatRepairAvailability('multi', 'second', { ...ready, writable: false });
    assert.equal(chatRepairAvailability('multi')?.writable, true);
    requestChatRepair('multi');
    assert.deepEqual((events.find(event => event.type === CHAT_REPAIR_REQUEST) as CustomEvent).detail,
      { sessionId: 'multi', owner: 'first' });
    setChatRepairAvailability('multi', 'second', undefined);
    assert.deepEqual(chatRepairAvailability('multi'), ready);
    setChatRepairAvailability('multi', 'first', { ...ready, offered: false });
    const priorCount = events.length;
    requestChatRepair('multi');
    assert.equal(events.length, priorCount, 'an active or unavailable view cannot open repair');
  } finally {
    setChatRepairAvailability('multi', 'first', undefined);
    globalThis.dispatchEvent = previous;
  }
});
