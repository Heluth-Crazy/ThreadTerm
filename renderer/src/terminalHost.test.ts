import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODERN_CONPTY_BUILD, selectedConptyHost, windowsPtyFor } from './terminalHost';

test('the setting means bundled unless the user chose the Windows host', () => {
  assert.equal(selectedConptyHost(undefined), 'bundled');
  assert.equal(selectedConptyHost('bundled'), 'bundled');
  assert.equal(selectedConptyHost('system'), 'system');
  assert.equal(selectedConptyHost('other'), 'bundled');
});

test('the bundled OpenConsole gets xterm\'s modern ConPTY behaviour on any Windows build', () => {
  assert.deepEqual(windowsPtyFor({ backend: 'conpty', buildNumber: 19045 }, 'bundled'), { backend: 'conpty', buildNumber: MODERN_CONPTY_BUILD });
  assert.deepEqual(windowsPtyFor({ backend: 'conpty', buildNumber: 26100 }, 'bundled'), { backend: 'conpty', buildNumber: 26100 });
});

test('the in-box ConPTY keeps the real OS build (a modern build there broke long lines)', () => {
  const os = { backend: 'conpty' as const, buildNumber: 19045 };
  assert.deepEqual(windowsPtyFor(os, 'system'), os);
  assert.deepEqual(windowsPtyFor(os, undefined), os, 'an older runtime without terminal.host');
});

test('no Windows metadata stays none', () => {
  assert.equal(windowsPtyFor(undefined, 'bundled'), undefined);
});
