import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalText } from './lib/terminal-text.mjs';

test('ConPTY positioned output preserves exact marker lines without accepting command echo', async () => {
  const echo = "PS C:\\project> Write-Output 'DEFAULT-SHELL-FIRST'";
  const marker = /^DEFAULT-SHELL-FIRST$/m;
  assert.doesNotMatch(await terminalText(echo), marker);
  const output = echo + '\x1b[2;1HDEFAULT-SHELL-FIRST\x1b[3;1HPS C:\\project> ';
  // The old ANSI stripper joins these three rows and loses the output boundary.
  assert.doesNotMatch(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, ''), marker);
  assert.match(await terminalText(output), marker);
});

test('terminal interpretation applies erase and carriage-return redraws', async () => {
  assert.doesNotMatch(await terminalText('DEFAULT-SHELL-FIRST\r\x1b[2Kreplacement'), /^DEFAULT-SHELL-FIRST$/m);
  assert.match(await terminalText('stale prompt\r\x1b[2KDEFAULT-SHELL-FIRST\r\n'), /^DEFAULT-SHELL-FIRST$/m);
});
