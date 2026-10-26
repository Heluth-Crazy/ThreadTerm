import assert from 'node:assert/strict';
import test from 'node:test';
import { colorContrastWarnings, colorDraftPatch, createColorDraft, deleteColorTheme, normalizeColor } from './colorEditor';
import { applyThemeTokens, resolveTheme, setThemePreview, type ThemeTokens } from './themes';
import { endColorPreview, previewColors } from './themePreview';

test('hex input accepts only full or short hex and normalizes it', () => {
  assert.equal(normalizeColor(' #AbC '), '#aabbcc');
  assert.equal(normalizeColor('#ABCDEF'), '#abcdef');
  for (const value of ['red', '#abcd', '#12345g', '123456', '', '#12345678']) assert.equal(normalizeColor(value), undefined);
});
test('preset drafts inherit fixed colours and save a deduplicated custom copy', () => {
  const preset = resolveTheme('preset:tokyo-night', { systemDark: false });
  const first = createColorDraft('preset:tokyo-night', {}, false);
  assert.equal(first.tokens.base, preset.presetId);
  assert.equal(first.name, 'Tokyo Night (custom)');
  const firstPatch = colorDraftPatch(first, {});
  const second = createColorDraft('preset:tokyo-night', firstPatch.customThemes, false);
  assert.equal(second.name, 'Tokyo Night (custom 2)');
  assert.equal(first.tokens.editor, preset.colors.editor);
  assert.equal(first.originalName, undefined);
  const duplicate = { ...first, name: second.name };
  assert.throws(() => colorDraftPatch(duplicate, { ...firstPatch.customThemes, [second.name]: first.tokens }), /Duplicate/);
});
test('custom edits preserve backgrounds, unrelated themes and original identity; save as new deduplicates', () => {
  const original = createColorDraft('light', {}, false).tokens;
  const image = { image: 'a'.repeat(64), opacity: 40, blur: 0, overlay: 70, fit: 'cover' as const, focusX: 50, focusY: 50, scale: 100 };
  const themes = { Ocean: { ...original, backgrounds: { window: image } }, Other: original };
  const draft = createColorDraft('custom:Ocean', themes, true);
  draft.tokens = { ...draft.tokens, editor: '#aabbcc' };
  const saved = colorDraftPatch(draft, themes);
  assert.equal(saved.themeSelection, 'custom:Ocean');
  assert.deepEqual(saved.customThemes.Ocean.backgrounds, themes.Ocean.backgrounds);
  assert.equal(saved.customThemes.Other, original);
  assert.equal(themes.Ocean.editor, original.editor);
  const copy = colorDraftPatch(draft, saved.customThemes, true);
  assert.equal(copy.themeSelection, 'custom:Ocean (custom)');
  assert.equal(copy.customThemes['Ocean (custom)'].editor, '#aabbcc');
  assert.equal(copy.customThemes.Ocean, saved.customThemes.Ocean);
  assert.throws(() => colorDraftPatch({ ...draft, name: ' ' }, themes, true), /Invalid name/);
  assert.throws(() => colorDraftPatch({ ...draft, tokens: { ...draft.tokens, text: 'bad' } }, themes), /Invalid colours/);
});
test('reset values come from the base preset; delete active custom falls back to its base', () => {
  const original = createColorDraft('preset:dracula', {}, false).tokens;
  const draft = createColorDraft('custom:Night', { Night: { ...original, surface: '#010203' } }, false);
  assert.equal(draft.base.surface, original.surface);
  assert.equal(draft.tokens.surface, '#010203');
  assert.deepEqual(deleteColorTheme('Night', { Night: draft.tokens }, 'custom:Night', false), { customThemes: {}, themeSelection: 'preset:dracula' });
  assert.deepEqual(deleteColorTheme('Night', { Night: draft.tokens }, 'light', false), { customThemes: {} });
});
test('contrast warnings use the exact foreground/surface pairs and quiet thresholds', () => {
  const tokens = createColorDraft('light', {}, false).tokens;
  assert.deepEqual(colorContrastWarnings(tokens), []);
  const warnings = colorContrastWarnings({ ...tokens, text: tokens.surface });
  assert.equal(warnings.find(warning => warning.foreground === 'text' && warning.surface === 'surface')?.ratio, 1);
  assert.equal(warnings.filter(warning => warning.foreground === 'text').length, 3);
  assert.ok(warnings.every(warning => warning.ratio < warning.minimum));
});
test('preview uses the resolved apply path, survives saved-settings events, and restores the latest saved theme', () => {
  const originalDocument = globalThis.document;
  const values = new Map<string, string>();
  const dataset: Record<string, string> = {};
  Object.assign(globalThis, { document: { documentElement: { dataset, style: { setProperty: (key: string, value: string) => values.set(key, value), removeProperty: (key: string) => values.delete(key) } } } });
  try {
    const light = resolveTheme('light', { systemDark: false });
    applyThemeTokens(undefined, light.mode, light);
    const before = new Map(values);
    const tokens: ThemeTokens = { ...createColorDraft('light', {}, false).tokens, surface: '#112233', editor: '#223344' };
    setThemePreview(tokens);
    assert.equal(values.get('--surface'), '#112233');
    assert.equal(values.get('--editor'), '#223344');
    applyThemeTokens(undefined, light.mode, light);
    assert.equal(values.get('--surface'), '#112233');
    setThemePreview(undefined);
    assert.deepEqual(values, before);
    assert.equal(dataset.customTheme, 'false');
    setThemePreview(tokens);
    const dark = resolveTheme('dark', { systemDark: false });
    applyThemeTokens(undefined, dark.mode, dark);
    setThemePreview(undefined);
    assert.equal(dataset.theme, 'dark');
    assert.equal(values.get('--editor'), dark.colors.editor);
    previewColors('older', tokens);
    previewColors('newer', { ...tokens, surface: '#445566' });
    endColorPreview('newer');
    assert.equal(values.get('--surface'), '#112233', 'closing the latest editor resumes the earlier draft');
    endColorPreview('older');
    assert.equal(values.get('--surface'), dark.colors.panel);
  } finally {
    setThemePreview(undefined);
    Object.assign(globalThis, { document: originalDocument });
  }
});
