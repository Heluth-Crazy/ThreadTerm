import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionStartup } from './sessionStartup';

test('default and explicit cmd preserve a command as one argument', () => {
  const command = 'echo "hello world" | findstr "world"';
  assert.deepEqual(sessionStartup(`  ${command}  `, true, 'win32'), { executable: 'cmd.exe', args: ['/D', '/S', '/C', command] });
  assert.deepEqual(sessionStartup(command, false, 'win32', 'cmd'), { executable: 'cmd.exe', args: ['/D', '/S', '/K', command] });
});

for (const shell of ['powershell', 'pwsh'] as const) {
  for (const oneShot of [false, true]) test(`${shell} ${oneShot ? 'run once' : 'interactive'} preserves PowerShell syntax`, () => {
    const command = 'Write-Output "hello $env:USERNAME"; Write-Output (1 + 2)';
    assert.deepEqual(sessionStartup(command, oneShot, 'win32', shell), {
      executable: `${shell}.exe`, args: ['-NoLogo', ...(!oneShot ? ['-NoExit'] : []), '-Command', command],
    });
  });
}

test('empty startup is resolved by runtime; non-Windows ignores Windows setting', () => {
  assert.deepEqual(sessionStartup('  ', false, 'win32', 'pwsh'), {});
  assert.deepEqual(sessionStartup('echo hello', true, 'linux', 'powershell'), { executable: '/bin/sh', args: ['-c', 'echo hello'] });
  assert.deepEqual(sessionStartup('echo hello', false, 'darwin', 'pwsh'), { executable: '/bin/sh', args: ['-ic', 'echo hello'] });
});
