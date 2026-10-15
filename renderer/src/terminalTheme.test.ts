import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalTheme } from './terminalTheme';

test('custom terminal theme uses custom surfaces while preserving the ANSI palette', () => {
  const custom = { background: '#182430', surface: '#22303d', text: '#f1f5f9', muted: '#94a3b8', accent: '#ff7a45', border: '#44505d' };
  const themed = terminalTheme('light', custom);
  assert.equal(themed.background, custom.background);
  assert.equal(themed.foreground, custom.text);
  assert.equal(themed.cursor, custom.accent);
  assert.equal(themed.selectionBackground, custom.accent);
  assert.equal(themed.selectionInactiveBackground, custom.accent);
  assert.equal(themed.red, terminalTheme('light').red);
});
