import test from 'node:test';
import assert from 'node:assert/strict';
import { clampOffset, folderName, modelLabel, pageCount, sessionHeading, sessionQuery, shortNativeId } from './usageSessions.js';

test('session paging params stay inside what the runtime accepts', () => {
  assert.deepEqual(sessionQuery({ sort: 'tokens', offset: 0 }), { sort: 'tokens', order: 'desc', limit: 25, offset: 0 });
  assert.deepEqual(sessionQuery({ sort: 'cost', offset: 50, limit: 1000 }), { sort: 'cost', order: 'desc', limit: 200, offset: 50 }, 'limit clamps to 200');
  assert.deepEqual(sessionQuery({ sort: 'recent', offset: -4 }).offset, 0, 'a negative offset is not sent');
  assert.deepEqual(sessionQuery({ sort: 'activeTime', offset: 12.6 }).offset, 13, 'offsets are integers');
  assert.equal(sessionQuery({ sort: 'tokens', offset: 0, limit: 0 }).limit, 1, 'limit clamps up to 1');
  assert.equal('search' in sessionQuery({ sort: 'tokens', offset: 0, search: '   ' }), false, 'a blank search is not sent');
  assert.equal(sessionQuery({ sort: 'tokens', offset: 0, search: '  claude  ' }).search, 'claude', 'search is trimmed');
  assert.equal(sessionQuery({ sort: 'tokens', offset: 0, search: 'x'.repeat(400) }).search?.length, 256, 'search is bounded');
});

test('paging math keeps the last page reachable', () => {
  assert.equal(pageCount(0, 25), 1);
  assert.equal(pageCount(25, 25), 1);
  assert.equal(pageCount(26, 25), 2);
  assert.equal(pageCount(120, 25), 5);
  assert.equal(clampOffset(0, 0, 25), 0);
  assert.equal(clampOffset(200, 30, 25), 25, 'a stale offset snaps back to the last page');
  assert.equal(clampOffset(-5, 30, 25), 0);
  assert.equal(clampOffset(25, 120, 25), 25);
});

test('a folder name never invents a drive letter or a user name', () => {
  assert.equal(folderName('D:/project/ThreadTerm'), 'ThreadTerm');
  assert.equal(folderName('C:\\Users\\someone\\work\\app'), 'app');
  assert.equal(folderName('work/demo/'), 'demo');
  assert.equal(folderName(''), null);
  assert.equal(folderName(null), null);
  assert.equal(folderName('D:'), null);
  assert.equal(folderName('/'), null);
});

test('the row heading is a ThreadTerm title, else a folder, else the native id', () => {
  const threadterm = { threadtermSessionId: 's1', cwd: 'D:/work/demo', nativeSessionId: 'native-0000000000' };
  assert.equal(sessionHeading(threadterm, 'Group chat runtime'), 'Group chat runtime');
  assert.equal(sessionHeading(threadterm, '   '), 'demo', 'a blank ThreadTerm title falls through to the folder');
  assert.equal(sessionHeading(threadterm), 'demo');
  assert.equal(sessionHeading({ threadtermSessionId: 's1', cwd: null, nativeSessionId: 'native-1' }), null, 'no title anywhere is the page\'s business');
  assert.equal(sessionHeading({ threadtermSessionId: null, cwd: 'D:/work/demo', nativeSessionId: 'native-1' }), 'demo');
  assert.equal(sessionHeading({ threadtermSessionId: null, cwd: null, nativeSessionId: '0123456789abcdef' }), '0123456789ab…');
});

test('a short native id is left alone and a long one is shortened', () => {
  assert.equal(shortNativeId('abc'), 'abc');
  assert.equal(shortNativeId('abcdefghijkl'), 'abcdefghijkl');
  assert.equal(shortNativeId('abcdefghijklm'), 'abcdefghijkl…');
});

test('the model label names one model and counts the rest', () => {
  assert.deepEqual(modelLabel(['gpt-5']), { model: 'gpt-5', extra: 0 });
  assert.deepEqual(modelLabel(['gpt-5', 'gpt-5-mini', 'o4']), { model: 'gpt-5', extra: 2 });
  assert.equal(modelLabel([]), null);
  assert.equal(modelLabel(['', '  ']), null, 'a blank model id is not a model');
});
