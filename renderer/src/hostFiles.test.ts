import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.edge';
import { HostFileRows, hostPathKey } from './components/HostFiles';

const entries = [{ name: 'Host folder', path: 'Z:/host', kind: 'directory' as const, size: 0 }, { name: 'host.log', path: '\\\\?\\Z:\\host.log', kind: 'file' as const, size: 2048 }];
test('host folder browser shows directories only, with native keyboard buttons', () => {
  const html = renderToStaticMarkup(createElement(HostFileRows, { entries, mode: 'directory', selected: [], busy: false, onDirectory() {}, onSelect() {} }));
  assert.match(html, /Host folder/); assert.doesNotMatch(html, /host\.log/); assert.match(html, /type="button"/); assert.match(html, /data-host-path="Z:\/host"/);
});
test('host file browser and Files panel retain selection across Windows canonical prefixes', () => {
  const html = renderToStaticMarkup(createElement(HostFileRows, { entries, mode: 'files', selected: ['z:/host.log'], busy: false, onDirectory() {}, onSelect() {} }));
  assert.match(html, /host\.log/); assert.match(html, /aria-pressed="true"/); assert.match(html, /2 KB/);
  assert.equal(hostPathKey('\\\\?\\Z:\\Host.LOG'), hostPathKey('z:/host.log'));
  assert.equal(hostPathKey('\\\\?\\UNC\\Server\\Share'), hostPathKey('\\\\server\\share'));
  assert.notEqual(hostPathKey('/Host/log'), hostPathKey('/host/log'));
});
