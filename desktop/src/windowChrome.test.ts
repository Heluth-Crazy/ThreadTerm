import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWindowChrome } from './windowChrome.js';

test('Windows 10 and earlier use the transparent CSS-rounded window', () => {
  assert.equal(resolveWindowChrome('win32', '10.0.19045'), 'transparent');
  assert.equal(resolveWindowChrome('win32', '6.3.9600'), 'transparent');
});

test('Windows 11 (build 22000+) uses native DWM corner rounding', () => {
  assert.equal(resolveWindowChrome('win32', '10.0.22000'), 'native');
  assert.equal(resolveWindowChrome('win32', '10.0.22631'), 'native');
});

test('non-Windows platforms keep the transparent path', () => {
  assert.equal(resolveWindowChrome('darwin', '24.5.0'), 'transparent');
  assert.equal(resolveWindowChrome('linux', '6.8.0'), 'transparent');
});

test('malformed release versions never select native chrome', () => {
  assert.equal(resolveWindowChrome('win32', '10.0'), 'transparent');
  assert.equal(resolveWindowChrome('win32', 'unknown'), 'transparent');
});

test('explicit override wins over OS detection', () => {
  assert.equal(resolveWindowChrome('win32', '10.0.19045', 'native'), 'native');
  assert.equal(resolveWindowChrome('win32', '10.0.22631', 'transparent'), 'transparent');
  assert.equal(resolveWindowChrome('win32', '10.0.22631', 'bogus'), 'native');
});
