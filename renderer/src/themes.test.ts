import assert from 'node:assert/strict';
import test from 'node:test';
import { applyThemeTokens, contrastRatio, customHoverTarget, customPrimaryForeground, customSwitchOffForeground, customTheme, customTokens, resolveTheme, subscribeThemeState, themeCssVariables, type ThemeTokens } from './themes';

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

test('custom theme entries keep the optional sidebar, editor and base keys', () => {
  const pack = { ocean: { ...tokens(), sidebar: '#101820', editor: '#141d26', base: 'tokyo-night' } };
  assert.deepEqual(customTheme({ themeSelection: 'custom:ocean', customThemes: pack }), pack.ocean);
  // Old packs (six keys only) stay valid and gain no new keys.
  const legacy = customTheme({ themeSelection: 'custom:ocean', customThemes: { ocean: tokens() } });
  assert.deepEqual(legacy, tokens());
  // Malformed optional keys reject the whole entry; unknown extra keys are ignored, as before.
  assert.equal(customTokens({ ...tokens(), sidebar: '#12345' }), undefined);
  assert.equal(customTokens({ ...tokens(), editor: 'blue' }), undefined);
  assert.equal(customTokens({ ...tokens(), base: 'Tokyo Night' }), undefined);
  assert.equal(customTokens({ ...tokens(), base: '' }), undefined);
  assert.equal(customTokens({ ...tokens(), base: 'a'.repeat(41) }), undefined);
  assert.deepEqual(customTokens({ ...tokens(), backgrounds: {} }), tokens());
  assert.equal(customTheme({ themeSelection: 'light', customThemes: pack }), undefined);
  assert.equal(customTheme({ themeSelection: 'custom:missing', customThemes: pack }), undefined);
});

test('resolveTheme maps every selection form onto a concrete palette', () => {
  const light = resolveTheme('light', { systemDark: true });
  assert.equal(light.presetId, 'threadterm-light');
  assert.equal(light.mode, 'light');
  assert.equal(light.custom, false);
  assert.equal(light.key, 'preset:threadterm-light');
  assert.equal(resolveTheme('dark', { systemDark: false }).presetId, 'threadterm-dark');
  assert.equal(resolveTheme('system', { systemDark: true }).presetId, 'threadterm-dark');
  assert.equal(resolveTheme(undefined, { systemDark: false }).presetId, 'threadterm-light');
  assert.equal(resolveTheme('nonsense', { systemDark: true }).presetId, 'threadterm-dark');
  assert.equal(resolveTheme('preset:github-dark', { systemDark: false }).presetId, 'github-dark');
  assert.equal(resolveTheme('preset:preset-does-not-exist', { systemDark: true }).presetId, 'threadterm-dark');
  // Paired families follow the OS, dark-only families keep their palette.
  assert.equal(resolveTheme('system:catppuccin', { systemDark: false }).name, 'Catppuccin Latte');
  assert.equal(resolveTheme('system:catppuccin', { systemDark: true }).name, 'Catppuccin Mocha');
  assert.equal(resolveTheme('system:gruvbox', { systemDark: false }).name, 'Gruvbox Light');
  assert.equal(resolveTheme('system:dracula', { systemDark: false }).name, 'Dracula');
  assert.equal(resolveTheme('system:unknown-family', { systemDark: false }).presetId, 'threadterm-light');
  assert.equal(resolveTheme('system:unknown-family', { systemDark: true }).presetId, 'threadterm-dark');
});

test('custom themes resolve their roles, base palette and accent foreground', () => {
  const dark = { ...tokens(), sidebar: '#101820', editor: '#141d26', base: 'tokyo-night' };
  const resolved = resolveTheme('custom:ocean', { systemDark: true, customThemes: { ocean: dark } });
  assert.equal(resolved.custom, true);
  assert.equal(resolved.key, 'custom:ocean');
  assert.equal(resolved.name, 'ocean');
  assert.equal(resolved.presetId, 'tokyo-night');
  assert.equal(resolved.colors.frame, dark.background);
  assert.equal(resolved.colors.sidebar, dark.sidebar);
  assert.equal(resolved.colors.panel, dark.surface);
  assert.equal(resolved.colors.editor, dark.editor);
  assert.equal(resolved.colors.accentFg, customPrimaryForeground(dark));
  assert.ok(contrastRatio(resolved.colors.accentFg, resolved.colors.accent) >= 4.5);
  assert.equal(resolved.ansi[1], resolveTheme('preset:tokyo-night', { systemDark: true }).ansi[1]);
  const inherited = resolveTheme('preset:tokyo-night', { systemDark: true });
  assert.deepEqual(resolved.syn, inherited.syn);
  assert.deepEqual([resolved.colors.ok, resolved.colors.warn, resolved.colors.danger], [inherited.colors.ok, inherited.colors.warn, inherited.colors.danger]);
});

test('custom themes default sidebar to the frame, editor to the panel and the base to the panel luminance', () => {
  const plain = tokens();
  const resolved = resolveTheme('custom:plain', { systemDark: false, customThemes: { plain } });
  assert.equal(resolved.colors.sidebar, plain.background);
  assert.equal(resolved.colors.editor, plain.surface);
  assert.equal(resolved.presetId, 'threadterm-dark');
  assert.equal(resolved.mode, 'dark');
  const lightPanel = resolveTheme('custom:plain', { systemDark: true, customThemes: { plain: { ...plain, surface: '#fefdfb', background: '#f5f4ef', text: '#23221f', muted: '#6c6961', border: '#e4e2da', accent: '#4f59c8' } } });
  assert.equal(lightPanel.presetId, 'threadterm-light');
  assert.equal(lightPanel.mode, 'light');
  // A missing custom theme falls back to ThreadTerm by the OS appearance.
  assert.equal(resolveTheme('custom:missing', { systemDark: true, customThemes: {} }).presetId, 'threadterm-dark');
  assert.equal(resolveTheme('custom:plain', { systemDark: false, customThemes: { plain: { ...plain, accent: 'nope' } } }).presetId, 'threadterm-light');
});

test('themeCssVariables exposes the existing tokens plus sidebar and editor', () => {
  const resolved = resolveTheme('preset:solarized-dark', { systemDark: true });
  const variables = themeCssVariables(resolved);
  const expected = ['--bg', '--side', '--sidebar', '--surface', '--editor', '--text', '--muted', '--border', '--primary', '--primary-fg', '--amber', '--danger', '--st-needs', '--st-running', '--st-failed', '--st-ended', '--term-bg', '--term-fg', '--syn-keyword', '--syn-string', '--syn-number', '--syn-comment', '--syn-function', '--syn-type', '--syn-property', '--syn-punct', '--syn-meta', '--syn-deleted'];
  assert.deepEqual(Object.keys(variables).sort(), expected.slice().sort());
  assert.equal(variables['--bg'], resolved.colors.frame);
  assert.equal(variables['--sidebar'], resolved.colors.sidebar);
  assert.equal(variables['--side'], resolved.colors.sidebar);
  assert.equal(variables['--surface'], resolved.colors.panel);
  assert.equal(variables['--editor'], resolved.colors.editor);
  assert.equal(variables['--term-bg'], resolved.colors.editor);
  assert.equal(variables['--primary'], resolved.colors.accent);
  assert.equal(variables['--primary-fg'], resolved.colors.accentFg);
  assert.equal(variables['--st-running'], resolved.colors.ok);
  assert.equal(variables['--syn-function'], resolved.syn.fn);
  assert.equal(variables['--syn-deleted'], resolved.colors.danger);
  for (const value of Object.values(variables)) assert.match(value, /^#[0-9a-f]{6}$/);
});
