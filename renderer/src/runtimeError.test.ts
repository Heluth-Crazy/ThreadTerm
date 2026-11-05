import assert from 'node:assert/strict';
import test from 'node:test';
import { pairingErrorText, userErrorText } from './runtimeError';

// The exact rejection text produced by `ipcRenderer.invoke` in the real app: only the message survives.
const ipcWrapped = (message: string) => new Error(`Error invoking remote method 'threadterm:request': RuntimeRequestError: ${message}`);

test('a code the UI explains is shown in the reader language, not the raw IPC text', () => {
  assert.equal(userErrorText(ipcWrapped('outbox_history_pruned: Refreshing the runtime snapshot'), 'fallback', true), '较早的事件记录已清理，正在刷新会话快照。');
  const caught = ipcWrapped('response_too_large: response exceeds 6291456 bytes');
  assert.equal(userErrorText(caught, 'fallback', false), 'This part of the conversation is too large to load at once.');
  assert.equal(userErrorText(caught, 'fallback', true), '此部分对话过大，无法一次加载。');
  const typed = Object.assign(new Error('response exceeds 6291456 bytes'), { code: 'response_too_large' });
  assert.equal(userErrorText(typed, 'fallback', true), '此部分对话过大，无法一次加载。');
});

test('schema startup codes explain how to recover on the runtime failure screen', () => {
  assert.equal(userErrorText(new Error('schema_too_new: database requires a newer reader'), 'fallback', false), 'This database was upgraded by a newer ThreadTerm. Update the app or restore a backup.');
  assert.equal(userErrorText(new Error('schema_too_new: database requires a newer reader'), 'fallback', true), '此数据库已由较新的 ThreadTerm 升级。请更新应用或恢复备份。');
  assert.equal(userErrorText(new Error('schema_backup_failed: access denied'), 'fallback', false), 'ThreadTerm could not back up the database before upgrading it. Check free disk space and folder permissions, then try again.');
  assert.equal(userErrorText(new Error('schema_backup_failed: access denied'), 'fallback', true), 'ThreadTerm 无法在升级数据库前创建备份。请检查磁盘空间和文件夹权限，然后重试。');
});

test('an unknown error shows its own sentence in one language, never the wrapper', () => {
  assert.equal(userErrorText(ipcWrapped('Session not found'), 'fallback', false), 'Session not found');
  assert.equal(userErrorText(new Error('The group changed. / 群聊已更新。'), 'fallback', true), '群聊已更新。');
  assert.equal(userErrorText(new Error('The group changed. / 群聊已更新。'), 'fallback', false), 'The group changed.');
  assert.equal(userErrorText(undefined, 'Could not load history.', false), 'Could not load history.', 'a missing message keeps the caller copy');
  assert.equal(userErrorText(new Error('   '), 'Could not load history.', false), 'Could not load history.');
});
test('pairing failures read as sentences: the address that could not be reached, and Tailscale missing on this PC', () => {
  const unreachable = new Error("Error invoking remote method 'threadterm:machine-prepare': Error: computer_unreachable: 172.18.0.1:57107");
  assert.match(pairingErrorText(unreachable, false), /^Couldn’t reach 172\.18\.0\.1:57107\. Make sure ThreadTerm is open/);
  assert.match(pairingErrorText(unreachable, true), /^无法连接到 172\.18\.0\.1:57107。/);
  const tailscale = new Error("Error invoking remote method 'threadterm:request': RuntimeRequestError: tailscale_not_connected: Tailscale is not connected on this PC");
  assert.match(pairingErrorText(tailscale, false), /^Tailscale is not connected on this PC\. Start Tailscale and sign in, or turn off/);
  assert.match(pairingErrorText(tailscale, true), /^本机未连接 Tailscale。/);
  assert.equal(pairingErrorText(new Error("Error invoking remote method 'threadterm:machine-prepare': Error: Pairing cancelled"), false), 'Pairing cancelled');
});
