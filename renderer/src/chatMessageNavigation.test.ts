import assert from 'node:assert/strict';
import test from 'node:test';
import { messageDestinations, messageWindow } from './chatMessageNavigation';
test('navigation uses user first lines and only cached turn statistics', () => {
  const messages = messageDestinations([
    { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'not listed' }], createdAt: '' },
    { id: 'u', role: 'user', turnId: 't', parts: [{ type: 'text', text: '\r\n 中文第一行\r\nsecond' }], createdAt: 'date' },
  ], new Map([['t', { additions: 3, deletions: 1 }]]));
  assert.deepEqual(messages, [{ id: 'u', preview: '中文第一行', createdAt: 'date', turnId: 't', additions: 3, deletions: 1 }]);
});
test('navigation virtualizes only above 200 with bounded mounted rows', () => {
  assert.equal(messageWindow(200, 1000).end, 200);
  for (const top of [0, 100, 12000, 600000]) {
    const window = messageWindow(10000, top);
    assert.ok(window.end - window.start <= 11);
    assert.equal(window.before + (window.end - window.start) * 60 + window.after, 600000);
  }
});
