import assert from 'node:assert/strict';
import test from 'node:test';
import { appearanceErrorMessage, applyBackgroundEdit, backgroundSettingsPatch, defaultBackgroundLayer } from './appearance/backgroundSettings';
import { resolveTheme, type ThemeTokens } from './themes';

const image = 'a'.repeat(64);
const otherImage = 'b'.repeat(64);
test('queued scale and opacity releases preserve earlier fit/focus and other-region changes', () => {
  const original = defaultBackgroundLayer(image);
  const latest = { window: { ...original, fit: 'contain' as const, focusX: 100, focusY: 100 }, chat: defaultBackgroundLayer(otherImage) };
  const merged = applyBackgroundEdit(latest, 'window', { ...original, scale: 175, opacity: 80 }, ['scale', 'opacity']);
  assert.deepEqual(merged, { ...latest, window: { ...latest.window, scale: 175, opacity: 80 } });
  assert.deepEqual(applyBackgroundEdit(latest, 'window', undefined), { chat: latest.chat });
  assert.deepEqual(applyBackgroundEdit(latest, 'window', defaultBackgroundLayer(otherImage)).window, defaultBackgroundLayer(otherImage));
  assert.throws(() => applyBackgroundEdit(latest, 'window', defaultBackgroundLayer(otherImage), ['scale']), /picture changed/);
});
const palette = (): ThemeTokens => ({
  background: '#101112', surface: '#202122', text: '#f0f1f2', muted: '#a0a1a2', accent: '#4455ee', border: '#303132',
  sidebar: '#131415', editor: '#232425', base: 'tokyo-night',
});

test('a preset background edit creates a collision-safe custom copy with its resolved palette', () => {
  const first = backgroundSettingsPatch('preset:tokyo-night', { 'Tokyo Night (custom)': palette() }, false, { window: defaultBackgroundLayer(image) });
  assert.equal(first.createdName, 'Tokyo Night (custom 2)');
  assert.equal(first.themeSelection, 'custom:Tokyo Night (custom 2)');
  assert.equal(first.customThemes[first.createdName!].base, 'tokyo-night');
  assert.deepEqual(first.customThemes[first.createdName!].backgrounds, { window: defaultBackgroundLayer(image) });
  assert.equal(first.customThemes['Tokyo Night (custom)'].background, '#101112');
  assert.equal(first.customThemes[first.createdName!].background, resolveTheme('preset:tokyo-night', { systemDark: false }).colors.frame);
});

test('a custom theme updates in place without losing its palette, base, or other themes', () => {
  const ocean = { ...palette(), backgrounds: { window: defaultBackgroundLayer(image) } };
  const other = { ...palette(), background: '#010203' };
  const result = backgroundSettingsPatch('custom:Ocean', { Ocean: ocean, Other: other }, true, { chat: defaultBackgroundLayer(otherImage) });
  assert.equal(result.createdName, undefined);
  assert.equal(result.themeSelection, 'custom:Ocean');
  assert.equal(result.customThemes.Ocean.background, ocean.background);
  assert.equal(result.customThemes.Ocean.base, ocean.base);
  assert.deepEqual(result.customThemes.Ocean.backgrounds, { chat: defaultBackgroundLayer(otherImage) });
  assert.equal(result.customThemes.Other, other);
});

test('inherit layers retain the default control shape and empty backgrounds are omitted', () => {
  assert.deepEqual(defaultBackgroundLayer('inherit'), { image: 'inherit', opacity: 100, blur: 0, overlay: 0, fit: 'cover', focusX: 50, focusY: 50, scale: 100 });
  const custom = { ...palette(), backgrounds: { window: defaultBackgroundLayer(image) } };
  const result = backgroundSettingsPatch('custom:Ocean', { Ocean: custom }, false, { editor: { ...defaultBackgroundLayer('inherit'), overlay: 64 } });
  assert.deepEqual(result.customThemes.Ocean.backgrounds, { editor: { ...defaultBackgroundLayer('inherit'), overlay: 64 } });
  const cleared = backgroundSettingsPatch('custom:Ocean', result.customThemes, false, {});
  assert.equal('backgrounds' in cleared.customThemes.Ocean, false);
});

test('appearance errors translate every image and pack code, including IPC messages, without leaking details', () => {
  for (const code of [
    'theme_pack_unreadable', 'theme_pack_empty', 'theme_pack_invalid_theme', 'theme_pack_invalid_image', 'theme_pack_too_large',
    'background_image_unsupported', 'background_image_too_large', 'background_image_limit', 'background_image_unreadable',
  ]) {
    const english = appearanceErrorMessage({ code }, false);
    const chinese = appearanceErrorMessage(new Error(`Error invoking remote method: Error: ${code}: secret-details`), true);
    assert.notEqual(english, code);
    assert.notEqual(chinese, code);
    assert.equal(english.includes('secret'), false);
    assert.equal(chinese.includes('secret'), false);
  }
  assert.equal(appearanceErrorMessage(new Error('unexpected secret-details'), false), 'Could not complete that action. Please try again.');
  assert.equal(appearanceErrorMessage(undefined, true), '操作未完成，请重试。');
});
