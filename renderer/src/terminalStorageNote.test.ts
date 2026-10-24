import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStorageEvent, storageNoteFromRead, terminalStorageAttention, terminalStorageLabel } from './terminalStorageNote';

test('a degraded read and a degraded event both produce the note', () => {
  assert.deepEqual(storageNoteFromRead({ reason: 'terminal_output_storage_failed' }), { reason: 'terminal_output_storage_failed' });
  assert.equal(storageNoteFromRead(undefined), undefined);
  assert.equal(storageNoteFromRead({}), undefined);
  assert.deepEqual(
    applyStorageEvent(undefined, 'term-1', { event: 'terminal.storage', data: { sessionId: 'term-1', degraded: true, reason: 'disk' } }),
    { reason: 'disk' },
  );
});

test('only the terminal that reported the failure shows it', () => {
  const note = { reason: 'disk' };
  assert.equal(applyStorageEvent(note, 'term-1', { event: 'terminal.storage', data: { sessionId: 'term-2', degraded: true, reason: 'disk' } }), note);
  assert.equal(applyStorageEvent(note, 'term-1', { event: 'runtime.degraded', data: { sessionId: 'term-1', area: 'chat' } }), note);
  assert.equal(applyStorageEvent(undefined, 'term-1', { event: 'terminal.storage', data: { sessionId: 'term-1', degraded: true } })?.reason, 'terminal_output_storage_failed');
});

test('recovery clears the note; both locales explain that the process still runs', () => {
  assert.equal(applyStorageEvent({ reason: 'disk' }, 'term-1', { event: 'terminal.storage', data: { sessionId: 'term-1', degraded: false } }), undefined);
  for (const zh of [true, false]) {
    assert.ok(terminalStorageAttention(zh).length > 20);
    assert.ok(terminalStorageLabel(zh).length > 1);
  }
  assert.notEqual(terminalStorageAttention(true), terminalStorageAttention(false));
});
