import assert from 'node:assert/strict';
import test from 'node:test';
import { contrastRatio } from './themes';
import { THEME_FAMILIES, THEME_PRESETS, familyPreset, presetById, presetsForFamily, type ThemePreset } from './themePresets';

const hex = /^#[0-9a-f]{6}$/;

test('every preset declares the full colour, syntax and ANSI shape', () => {
  assert.equal(THEME_PRESETS.length, 15);
  assert.equal(new Set(THEME_PRESETS.map(preset => preset.id)).size, 15);
  for (const preset of THEME_PRESETS) {
    assert.match(preset.id, /^[a-z0-9-]+$/);
    assert.ok(preset.name.trim().length > 0);
    assert.ok(preset.family.trim().length > 0);
    assert.ok(preset.mode === 'light' || preset.mode === 'dark');
    for (const [role, value] of Object.entries(preset.c)) assert.match(value, hex, `${preset.id} role ${role}`);
    for (const [role, value] of Object.entries(preset.syn)) assert.match(value, hex, `${preset.id} syntax ${role}`);
    assert.equal(preset.ansi.length, 16, `${preset.id} ANSI palette`);
    for (const value of preset.ansi) assert.match(value, hex, `${preset.id} ANSI colour`);
  }
  assert.equal(presetById('tokyo-night')?.name, 'Tokyo Night');
  assert.equal(presetById('nope'), undefined);
  assert.equal(presetById(undefined), undefined);
});

test('families pair presets and dark-only families stay dark', () => {
  assert.equal(new Set(THEME_FAMILIES.map(family => family.id)).size, THEME_FAMILIES.length);
  for (const family of THEME_FAMILIES) {
    assert.match(family.id, /^[a-z0-9-]+$/, family.id);
    assert.ok(family.light || family.dark, `${family.id} has a preset`);
    for (const id of [family.light, family.dark]) if (id !== undefined) assert.ok(presetById(id), `${family.id} -> ${id}`);
    for (const preset of presetsForFamily(family.id)) assert.equal(preset.family, family.name);
    assert.equal(presetsForFamily(family.id).length, family.light && family.dark ? 2 : 1, family.id);
  }
  const paired = THEME_FAMILIES.filter(family => family.light && family.dark).map(family => family.id);
  assert.deepEqual(paired, ['threadterm', 'github', 'solarized', 'catppuccin', 'rose-pine', 'gruvbox']);
  assert.deepEqual(THEME_FAMILIES.filter(family => !family.light).map(family => family.id), ['nord', 'tokyo-night', 'dracula']);
  // Paired families follow the OS; dark-only families keep their single palette in both appearances.
  assert.equal(familyPreset('github', false)?.id, 'github-light');
  assert.equal(familyPreset('github', true)?.id, 'github-dark');
  assert.equal(familyPreset('rose-pine', false)?.id, 'rose-pine-dawn');
  assert.equal(familyPreset('nord', false)?.id, 'nord');
  assert.equal(familyPreset('nord', true)?.id, 'nord');
  assert.equal(familyPreset('missing', true), undefined);
  assert.equal(presetsForFamily('missing').length, 0);
});

// Contrast gate (WCAG 2.1 relative luminance, see contrastRatio). Never relax these floors; fix the preset data.
const gate: [string, (preset: ThemePreset) => [string, string], number][] = [
  ['text on panel', preset => [preset.c.text, preset.c.panel], 4.5],
  ['text on editor', preset => [preset.c.text, preset.c.editor], 4.5],
  ['text on sidebar', preset => [preset.c.text, preset.c.sidebar], 4.5],
  ['muted on panel', preset => [preset.c.muted, preset.c.panel], 3],
  ['muted on frame', preset => [preset.c.muted, preset.c.frame], 3],
  ['accent foreground on accent', preset => [preset.c.accentFg, preset.c.accent], 4.5],
  ['accent on panel', preset => [preset.c.accent, preset.c.panel], 3],
  ...Array.from({ length: 6 }, (_, index): [string, (preset: ThemePreset) => [string, string], number] => [
    `ANSI ${index + 1} on editor`, preset => [preset.ansi[index + 1], preset.c.editor], 3,
  ]),
];

test('every preset meets the contrast gate on its own surfaces', () => {
  const failures: string[] = [];
  for (const preset of THEME_PRESETS) {
    for (const [label, pick, floor] of gate) {
      const [foreground, background] = pick(preset);
      const ratio = contrastRatio(foreground, background);
      if (ratio < floor) failures.push(`${preset.id}: ${label} ${foreground} on ${background} = ${ratio.toFixed(2)} < ${floor}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('light and dark presets sit on the expected side of the luminance scale', () => {
  for (const preset of THEME_PRESETS) {
    const surface = contrastRatio(preset.c.text, preset.c.panel);
    assert.ok(surface > 1, preset.id);
    const lightSurface = contrastRatio(preset.c.panel, '#ffffff') < 2;
    assert.equal(lightSurface, preset.mode === 'light', `${preset.id} mode`);
  }
});
