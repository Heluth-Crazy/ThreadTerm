import assert from 'node:assert/strict';
import test from 'node:test';
import { userErrorText } from './runtimeError';

// The exact rejection text produced by `ipcRenderer.invoke` in the real app: only the message survives.
const ipcWrapped = (message: string) => new Error(`Error invoking remote method 'threadterm:request': RuntimeRequestError: ${message}`);

test('a code the UI explains is shown in the reader language, not the raw IPC text', () => {
  const caught = ipcWrapped('response_too_large: response exceeds 6291456 bytes');
  assert.equal(userErrorText(caught, 'fallback', false), 'This part of the conversation is too large to load at once.');
  assert.equal(userErrorText(caught, 'fallback', true), '此部分对话过大，无法一次加载。');
  const typed = Object.assign(new Error('response exceeds 6291456 bytes'), { code: 'response_too_large' });
  assert.equal(userErrorText(typed, 'fallback', true), '此部分对话过大，无法一次加载。');
});

test('an unknown error shows its own sentence in one language, never the wrapper', () => {
  assert.equal(userErrorText(ipcWrapped('Session not found'), 'fallback', false), 'Session not found');
  assert.equal(userErrorText(new Error('The group changed. / 群聊已更新。'), 'fallback', true), '群聊已更新。');
  assert.equal(userErrorText(new Error('The group changed. / 群聊已更新。'), 'fallback', false), 'The group changed.');
  assert.equal(userErrorText(undefined, 'Could not load history.', false), 'Could not load history.', 'a missing message keeps the caller copy');
  assert.equal(userErrorText(new Error('   '), 'Could not load history.', false), 'Could not load history.');
});
