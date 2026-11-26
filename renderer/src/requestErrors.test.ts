import assert from 'node:assert/strict';
import test from 'node:test';
import { inlineErrorText, isRepeatableRead, normalizeRequestError, RuntimeRequestError, transportKind } from './requestErrors';
import { runtimeErrorCode } from './runtimeErrors';
import { currentNotices, dismissNotice, notify, reportTransportFailure, reportTransportRecovered, subscribeNotices, TRANSPORT_NOTICE } from './notices';

const wrapped = (text: string) => new Error(`Error invoking remote method 'threadterm:request': ${text}`);

test('the owner\'s screenshot error is a read timeout, told in the reader\'s language without the IPC wrapper', () => {
  const error = normalizeRequestError(wrapped('RuntimeUnavailableError: Runtime request worktree.list timed out'), 'worktree.list', true);
  assert.ok(error instanceof RuntimeRequestError);
  assert.equal(error.code, 'runtime_timeout');
  assert.equal(transportKind(error), 'timeout');
  assert.doesNotMatch(error.message, /Error invoking|RuntimeUnavailableError|worktree\.list/);
  assert.match(error.message, /后台暂时没有响应/);
  assert.equal(inlineErrorText(error, () => 'shown inline'), undefined, 'views leave transport failures to the app-wide notice');
});

test('an action that timed out may still be running; a dropped connection is unavailable', () => {
  const action = normalizeRequestError(wrapped('RuntimeUnavailableError: Runtime request git.push timed out'), 'git.push', false);
  assert.match(action.message, /may still be running/);
  for (const raw of ['RuntimeUnavailableError: Runtime pipe closed', 'RuntimeUnavailableError: Runtime connection changed before the session request was sent']) {
    assert.equal(transportKind(normalizeRequestError(wrapped(raw), 'chat.snapshot', false)), 'unavailable');
  }
});

test('the runtime\'s own failures lose only the wrapper: their codes still lead and views explain them', () => {
  const error = normalizeRequestError(wrapped('Error: revision_conflict: the layout changed'), 'workspace.save', false);
  assert.equal(error.message, 'revision_conflict: the layout changed');
  assert.equal(runtimeErrorCode(error), 'revision_conflict');
  assert.equal(transportKind(error), undefined);
  assert.equal(inlineErrorText(error, caught => `explained ${runtimeErrorCode(caught)}`), 'explained revision_conflict');
  const plain = new Error('session_not_found');
  assert.equal(normalizeRequestError(plain, 'chat.send', false), plain, 'an unwrapped error passes through unchanged');
});

test('only reads are repeatable', () => {
  assert.equal(isRepeatableRead('worktree.list'), true);
  assert.equal(isRepeatableRead('runtime.snapshot'), true);
  assert.equal(isRepeatableRead('chat.send'), false);
  assert.equal(isRepeatableRead('git.push'), false);
  assert.equal(isRepeatableRead('inbox.read'), false, 'inbox.read marks items read');
});

test('notices: one per key, newest text wins, at most four', () => {
  for (const notice of currentNotices()) dismissNotice(notice.key);
  notify({ key: 'a', tone: 'error', text: 'first' });
  notify({ key: 'a', tone: 'error', text: 'second' });
  assert.deepEqual(currentNotices().map(row => row.text), ['second']);
  for (const key of ['b', 'c', 'd', 'e']) notify({ key, tone: 'info', text: key });
  assert.deepEqual(currentNotices().map(row => row.key), ['b', 'c', 'd', 'e']);
  assert.equal(currentNotices()[0].ttlMs, 4_000, 'info closes by itself');
  for (const notice of currentNotices()) dismissNotice(notice.key);
});

test('a read timeout raises the transport notice; the next answer clears it, once', () => {
  let changes = 0;
  const stop = subscribeNotices(() => { changes++; });
  reportTransportRecovered();
  assert.equal(changes, 0, 'an answer with no failure before it changes nothing');
  reportTransportFailure('timeout', false);
  const notice = currentNotices().find(row => row.key === TRANSPORT_NOTICE);
  assert.ok(notice && notice.tone === 'warning' && notice.ttlMs === undefined, 'stays until the runtime answers');
  reportTransportRecovered();
  assert.equal(currentNotices().some(row => row.key === TRANSPORT_NOTICE), false);
  reportTransportFailure('unavailable', false);
  assert.equal(currentNotices().some(row => row.key === TRANSPORT_NOTICE), false, 'a lost connection is the status chip\'s job');
  reportTransportRecovered();
  stop();
});
