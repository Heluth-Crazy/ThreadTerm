import test from 'node:test';
import assert from 'node:assert/strict';
import { forkHistory } from '../src/nativeFork.mjs';

test('chosen Claude reply uses its exact native UUID with no query or input', async () => {
  const calls = [];
  const sdk = {forkSession: async (...args) => { calls.push(args); return {sessionId:'child-native'}; }, query: () => { throw Error('must not start a query'); }};
  assert.deepEqual(await forkHistory(sdk,{sessionId:'source-native',cwd:'C:/project',messageId:'reply-uuid'}),{sessionId:'child-native'});
  assert.deepEqual(calls,[['source-native',{dir:'C:/project',upToMessageId:'reply-uuid'}]]);
  await forkHistory(sdk,{sessionId:'source-native'});
  assert.deepEqual(calls[1],['source-native',{}]);
});
test('invalid fork fields fail before the SDK and native failures propagate', async () => {
  const sdk = {forkSession: async () => { throw Error('native unavailable'); }};
  for (const request of [{sessionId:''},{sessionId:1},{sessionId:'s',messageId:''},{sessionId:'s',messageId:1},{sessionId:'s',cwd:1}]) {
    await assert.rejects(forkHistory(sdk,request), /required|non-empty/);
  }
  await assert.rejects(forkHistory(sdk,{sessionId:'s'}), /native unavailable/);
});
