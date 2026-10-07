import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { createRequire } from 'node:module';
Object.assign(globalThis, { require: createRequire(import.meta.url) });
const { renderToStaticMarkup } = await import('react-dom/server');
import { ContextMenu } from './ContextMenu';

test('shared menu renders accessible disabled explanations, shortcuts and separators', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { lang: 'en' } } });
  try {
    const html = renderToStaticMarkup(createElement(ContextMenu, { x: 100, y: 200, onClose: () => {}, items: [
      { label: 'Comment on lines 12–20', disabled: true, reason: 'Save or discard your edits first: they move the lines.' },
      { id: 'copy', label: 'Copy', shortcut: 'Ctrl+C', onSelect: () => {} },
      { label: '', separator: true },
      { label: 'Discard changes', danger: true, onSelect: () => {} },
    ] }));
    assert.match(html, /role="menu"/);
    assert.equal((html.match(/role="menuitem"/g) ?? []).length, 3);
    assert.match(html, /aria-disabled="true"/);
    assert.match(html, /aria-description="Save or discard your edits first: they move the lines\."/);
    assert.match(html, /title="Save or discard your edits first: they move the lines\."/);
    // The shortcut is announced as aria-keyshortcuts, not as part of the item's name ("Copy", not "CopyCtrl+C").
    assert.match(html, /<kbd aria-hidden="true">Ctrl\+C<\/kbd>/);
    assert.match(html, /aria-keyshortcuts="Ctrl\+C"/);
    assert.match(html, /role="separator"/);
    assert.match(html, /app-context-item danger/);
    assert.equal((html.match(/class="app-context-icon"/g) ?? []).length, 3);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
