import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalPtyFromArguments, terminalWindowArguments } from '../src/terminalEnvironment';

test('Windows host release reaches the sandbox as the actual ConPTY build', () => {
  for (const buildNumber of [19045, 22631]) {
    const args = terminalWindowArguments('win32', `10.0.${buildNumber}`);
    assert.deepEqual(terminalPtyFromArguments('win32', ['electron.exe', ...args]), { backend: 'conpty', buildNumber });
  }
});

test('non-Windows hosts and absent or malformed metadata never enable Windows heuristics', () => {
  assert.deepEqual(terminalWindowArguments('linux', '6.8.0'), []);
  assert.deepEqual(terminalWindowArguments('darwin', '25.0.0'), []);
  assert.equal(terminalPtyFromArguments('linux', ['--threadterm-windows-build=19045']), undefined);
  for (const value of ['', '0', '-1', 'NaN', '1.5', '9007199254740993']) {
    assert.equal(terminalPtyFromArguments('win32', [`--threadterm-windows-build=${value}`]), undefined);
  }
  assert.equal(terminalPtyFromArguments('win32', []), undefined);
  assert.deepEqual(terminalWindowArguments('win32', 'unknown'), []);
});
