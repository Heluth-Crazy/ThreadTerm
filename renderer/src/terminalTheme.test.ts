import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalTheme, xtermThemeFor } from './terminalTheme';
import { resolveTheme } from './themes';

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

test('xtermThemeFor puts the terminal on the editor role with the preset ANSI palette', () => {
  const resolved = resolveTheme('preset:gruvbox-dark', { systemDark: true });
  const theme = xtermThemeFor(resolved);
  assert.equal(theme.background, resolved.colors.editor);
  assert.equal(theme.foreground, resolved.colors.text);
  assert.equal(theme.cursor, resolved.colors.accent);
  assert.equal(theme.cursorAccent, resolved.colors.accentFg);
  assert.equal(theme.selectionBackground, `${resolved.colors.accent}59`);
  assert.equal(theme.selectionInactiveBackground, `${resolved.colors.accent}33`);
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;
  assert.deepEqual(names.map(name => theme[name]), [...resolved.ansi]);
  // A custom theme with its own editor role wins over the base preset's editor colour.
  const custom = resolveTheme('custom:ocean', { systemDark: true, customThemes: { ocean: { background: '#0b1020', surface: '#131a2b', editor: '#182238', text: '#e2e8f0', muted: '#94a3b8', accent: '#7aa2f7', border: '#26314a', base: 'tokyo-night' } } });
  assert.equal(xtermThemeFor(custom).background, '#182238');
  assert.equal(xtermThemeFor(custom).red, resolveTheme('preset:tokyo-night', { systemDark: true }).ansi[1]);
});
