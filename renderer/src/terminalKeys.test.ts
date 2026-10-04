import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shiftEnterBytes } from './terminalKeys';

const key = (overrides: Partial<Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'isComposing'>> = {}) =>
  ({ key: 'Enter', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, ...overrides });

test('Shift+Enter is a newline (ESC CR) for Claude and Codex terminals', () => {
  assert.equal(shiftEnterBytes('claude', key()), '\x1b\r');
  assert.equal(shiftEnterBytes('codex', key()), '\x1b\r');
});

test('shells and unverified clients keep xterm\'s own Enter', () => {
  for (const provider of ['shell', 'custom', 'kimi', 'grok', 'gemini', 'opencode']) assert.equal(shiftEnterBytes(provider, key()), undefined, provider);
});

test('only plain Shift+Enter outside an IME composition is changed', () => {
  assert.equal(shiftEnterBytes('claude', key({ shiftKey: false })), undefined, 'Enter submits');
  assert.equal(shiftEnterBytes('claude', key({ ctrlKey: true })), undefined);
  assert.equal(shiftEnterBytes('claude', key({ altKey: true })), undefined, 'xterm already sends ESC CR for Alt+Enter');
  assert.equal(shiftEnterBytes('claude', key({ metaKey: true })), undefined);
  assert.equal(shiftEnterBytes('claude', key({ isComposing: true })), undefined, 'the IME owns Enter while composing');
  assert.equal(shiftEnterBytes('claude', key({ key: 'a' })), undefined);
});
