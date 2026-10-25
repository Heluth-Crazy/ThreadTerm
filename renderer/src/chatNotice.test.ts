import assert from 'node:assert/strict';
import test from 'node:test';
import { noticeDismissalKey, noticeWasDismissed, rememberNoticeDismissal } from './chatNotice';

test('notice dismissal follows CLI version and feature across chats and translations', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const notice = { code: 'codex_cli_limited', version: 'fixture-version', feature: 'empty-chat', message: 'English / 中文' };
  assert.equal(noticeWasDismissed(notice, storage), false);
  rememberNoticeDismissal(notice, storage);
  assert.equal(values.get(noticeDismissalKey(notice)), 'dismissed');
  assert.equal(noticeWasDismissed({ ...notice, message: 'Translated text' }, storage), true);
  assert.equal(noticeWasDismissed({ ...notice, version: 'new-version' }, storage), false);
  assert.equal(noticeWasDismissed({ ...notice, feature: 'saved-history' }, storage), false);
});

test('blocked storage preserves dismissal in memory and legacy notices distinguish new limits', () => {
  const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  const notice = { code: 'legacy', message: 'one limitation' };
  assert.equal(noticeWasDismissed(notice, storage), false);
  rememberNoticeDismissal(notice, storage);
  assert.equal(noticeWasDismissed(notice, storage), true);
  assert.equal(noticeWasDismissed({ ...notice, message: 'another limitation' }, storage), false);
});

test('a persisted dismissal is read in a fresh store', () => {
  const notice = { code: 'stored', version: 'other-version', feature: 'other-feature', message: 'limit' };
  assert.equal(noticeWasDismissed(notice, { getItem: key => key === noticeDismissalKey(notice) ? 'dismissed' : null, setItem: () => {} }), true);
});
