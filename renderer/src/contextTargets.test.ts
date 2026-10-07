import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachChatContext, insertSessionText, registerChatInputTarget, registerTerminalInputTarget } from './terminalInputTargets';
import type { ContextItem } from './chatContext';

test('context targets attach only to the visible Chat while terminal references stay inline', () => {
  const calls: unknown[] = [];
  const item: ContextItem = { kind: 'file', id: 'file', path: 'src/cart.ts', startLine: 12, endLine: 20 };
  const terminal = registerTerminalInputTarget('shell', { visible: () => true, insert: text => calls.push(text) });
  const chat = registerChatInputTarget('chat', { visible: () => true, insert: text => calls.push(text), attachContext: context => { calls.push(context); return true; } });
  const hidden = registerChatInputTarget('chat', { visible: () => false, insert: () => assert.fail(), attachContext: () => assert.fail() });
  try {
    assert.equal(attachChatContext('chat', item), true);
    insertSessionText('shell', 'src/cart.ts:12-20');
    insertSessionText('chat', 'Comment text stays inline');
    assert.deepEqual(calls, [item, 'src/cart.ts:12-20', 'Comment text stays inline']);
    assert.throws(() => attachChatContext('shell', item), /unavailable/);
    assert.throws(() => insertSessionText('shell', 'bad\nreference'), /single_line/);
  } finally { terminal(); chat(); hidden(); }
});
