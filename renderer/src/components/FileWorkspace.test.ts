import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.edge';
import { ExternalFileBoundary } from './FileWorkspace';

test('external file boundary exposes the read-only permission boundary and absolute path', () => {
  const path = 'C:\\outside folder\\notes.md';
  const html = renderToStaticMarkup(createElement(ExternalFileBoundary, {
    path, zh: false, noticeOpen: true, onNoticeToggle: () => {}, onCopy: () => {}, onReload: () => {},
  }));
  assert.match(html, /data-testid="external-file-boundary"/);
  assert.match(html, /Outside workspace · Read-only/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /ThreadTerm opens this file read-only/);
  assert.match(html, /title="C:\\outside folder\\notes\.md"/);
  assert.match(html, /Copy path/);
  assert.match(html, /Reload from disk/);
});
