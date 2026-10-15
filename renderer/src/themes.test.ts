import assert from 'node:assert/strict';
import test from 'node:test';
import { applyThemeTokens, contrastRatio, customHoverTarget, customPrimaryForeground, customSwitchOffForeground, subscribeThemeState, type ThemeTokens } from './themes';

const tokens = (overrides: Partial<ThemeTokens> = {}): ThemeTokens => ({ background: '#182430', surface: '#22303d', text: '#f1f5f9', muted: '#94a3b8', accent: '#ff7a45', border: '#44505d', ...overrides });

test('custom primary foreground selects the better custom token when it meets contrast', () => {
  const theme = tokens({ accent: '#303030' });
  assert.equal(customPrimaryForeground(theme), theme.text);
  assert.ok(contrastRatio(theme.accent, customPrimaryForeground(theme)) >= 4.5);
});
test('custom primary foreground falls back to an accessible near-black or white', () => {
  const theme = tokens({ text: '#888888', background: '#999999', accent: '#777777' });
  assert.equal(customPrimaryForeground(theme), '#000000');
  assert.ok(contrastRatio(theme.accent, customPrimaryForeground(theme)) >= 4.5);
});
test('custom foreground fallbacks meet AA across representative middle tones', () => {
  for (const accent of ['#666666', '#777777', '#888888', '#999999']) assert.ok(contrastRatio(accent, customPrimaryForeground(tokens({ accent, text: '#808080', background: '#888888' }))) >= 4.5, accent);
});
test('custom hover target follows custom background luminance', () => {
  assert.equal(customHoverTarget(tokens()), '#f1f5f9');
  assert.equal(customHoverTarget(tokens({ background: '#f5f4ef', text: '#23221f' })), '#23221f');
});

test('custom hover fallback keeps the direction for nearly black and white accents', () => {
  assert.equal(customHoverTarget(tokens({ background: '#ffffff', accent: '#050505', text: '#ffffff' })), '#000000');
  assert.equal(customHoverTarget(tokens({ accent: '#eeeeee', text: '#000000' })), '#ffffff');
});
test('applying theme tokens exposes contrast properties and signals only actual changes', () => {
  const values = new Map<string, string>();
  const originalDocument = globalThis.document;
  Object.assign(globalThis, { document: { documentElement: { style: { removeProperty: (key: string) => values.delete(key), setProperty: (key: string, value: string) => values.set(key, value) } } } });
  let changes = 0;
  const unsubscribe = subscribeThemeState(() => { changes += 1; });
  try {
    const theme = tokens();
    applyThemeTokens(theme, 'dark');
    applyThemeTokens(theme, 'dark');
    assert.equal(values.get('--custom-primary-fg'), customPrimaryForeground(theme));
    assert.equal(values.get('--custom-hover-target'), customHoverTarget(theme));
    assert.equal(values.get('--custom-switch-off-fg'), customSwitchOffForeground(theme));
    assert.equal(changes, 1);
    applyThemeTokens(undefined, 'light');
    assert.equal(values.has('--custom-primary-fg'), false);
    assert.equal(changes, 2);
  } finally {
    unsubscribe();
    Object.assign(globalThis, { document: originalDocument });
  }
});
test('custom switch off foreground remains visible when custom muted and surface match', () => {
  const theme = tokens({ muted: '#94a3b8', surface: '#94a3b8' });
  assert.ok(contrastRatio(theme.muted, customSwitchOffForeground(theme)) >= 4.5);
});
