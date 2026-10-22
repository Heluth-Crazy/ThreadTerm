import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserAddressParts } from './browserAddress';

test('HTTP addresses show the host and meaningful suffix without the scheme or www', () => {
 for (const [text, scheme, host, rest] of [
  ['https://example.com/docs', 'https', 'example.com', '/docs'],
  ['http://localhost:5173/path', 'http', 'localhost:5173', '/path'],
  ['https://www.example.com/', 'https', 'example.com', ''],
  ['https://www.example.com:8443/docs?q=hello#part', 'https', 'example.com:8443', '/docs?q=hello#part'],
  ['http://example.com', 'http', 'example.com', ''],
  ['https://example.com/?q=hello#part', 'https', 'example.com', '?q=hello#part'],
  ['http://[::1]:5173/', 'http', '[::1]:5173', ''],
  ['https://[2001:db8::1]/docs#part', 'https', '[2001:db8::1]', '/docs#part'],
 ] as const) assert.deepEqual(browserAddressParts(text), { scheme, host, rest });
});

test('other schemes and incomplete addresses retain the original text', () => {
 for (const text of ['file:///C:/project/index.html', 'data:text/plain,hello', 'about:blank', 'garbage', '', 'https://', 'https://[invalid]/']) {
  assert.deepEqual(browserAddressParts(text), { scheme: 'other', host: text, rest: '' });
 }
});
