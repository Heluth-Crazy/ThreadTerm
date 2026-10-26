import { contrastRatio, customPrimaryForeground, customTokens, resolveTheme, type ThemeTokens } from './themes';
import { customCopyName, customThemeFromResolved } from './appearance/backgrounds';

export const colorRoles = ['background', 'sidebar', 'surface', 'editor', 'text', 'muted', 'border', 'accent'] as const;
export type ColorRole = typeof colorRoles[number];
export type ColorDraft = { originalName?: string; name: string; tokens: ThemeTokens; base: ThemeTokens };

export function normalizeColor(value: string): string | undefined {
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-f]{3}$/.test(hex)) return '#' + [...hex.slice(1)].map(channel => channel + channel).join('');
  return undefined;
}
export function createColorDraft(selection: string, themes: Record<string, ThemeTokens>, systemDark: boolean): ColorDraft {
  const resolved = resolveTheme(selection, { systemDark, customThemes: themes });
  const originalName = resolved.custom ? resolved.name : undefined;
  const tokens = { ...customThemeFromResolved(resolved), ...(originalName ? themes[originalName] : {}) };
  const base = customThemeFromResolved(resolveTheme(`preset:${resolved.presetId}`, { systemDark }));
  return { originalName, name: originalName ?? customCopyName(resolved.name, Object.keys(themes)), tokens, base };
}
/** Save never replaces an unrelated theme, including one created in another window during editing. */
export function colorDraftPatch(draft: ColorDraft, themes: Record<string, ThemeTokens>, asNew = false): { customThemes: Record<string, ThemeTokens>; themeSelection: string } {
  const tokens = customTokens(draft.tokens);
  if (!tokens) throw Error('Invalid colours');
  let name = draft.name.trim();
  if (!name || name.length > 60) throw Error('Invalid name');
  if (asNew && (name === draft.originalName || themes[name])) name = customCopyName(name, Object.keys(themes));
  if (!asNew && draft.originalName) name = draft.originalName;
  if (name.length > 60) throw Error('Invalid name');
  if (name !== draft.originalName && themes[name]) throw Error('Duplicate name');
  return { customThemes: { ...themes, [name]: tokens }, themeSelection: `custom:${name}` };
}
export function deleteColorTheme(name: string, themes: Record<string, ThemeTokens>, selection: string, systemDark: boolean) {
  const resolved = resolveTheme(`custom:${name}`, { systemDark, customThemes: themes });
  const next = { ...themes };
  delete next[name];
  return { customThemes: next, ...(selection === `custom:${name}` ? { themeSelection: `preset:${resolved.presetId}` } : {}) };
}
export type ContrastWarning = { foreground: 'text' | 'muted' | 'accent'; surface: 'surface' | 'editor' | 'sidebar' | 'background'; ratio: number; minimum: number };
export function colorContrastWarnings(tokens: ThemeTokens): ContrastWarning[] {
  const checks = [
    ['text', 'surface', 4.5], ['text', 'editor', 4.5], ['text', 'sidebar', 4.5],
    ['muted', 'surface', 3], ['muted', 'background', 3], ['accent', 'surface', 3],
  ] as const;
  return checks.flatMap(([foreground, surface, minimum]) => {
    const background = tokens[surface] ?? (surface === 'sidebar' ? tokens.background : tokens.surface);
    const ratio = contrastRatio(tokens[foreground], background);
    return ratio < minimum ? [{ foreground, surface, ratio, minimum }] : [];
  });
}
export function accentForegroundContrast(tokens: ThemeTokens): number {
  return contrastRatio(tokens.accent, customPrimaryForeground(tokens));
}
