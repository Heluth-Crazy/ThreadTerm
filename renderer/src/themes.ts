import { useSyncExternalStore } from "react";
import { familyPreset, presetById, THEME_PRESETS, type AnsiPalette, type SyntaxColors, type ThemePreset, type ThemeRoleColors } from "./themePresets";

/** Custom theme colours. `sidebar`/`editor` are optional role overrides (default: background/surface) and `base` is the
 * preset id that supplies syntax, ANSI and status colours. Phase D adds `backgrounds`; until the runtime accepts it,
 * that key is rejected by both the settings validation and `customTokens`. */
export type ThemeTokens = {
  background: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
  sidebar?: string;
  editor?: string;
  base?: string;
};
const keys = [
  "background",
  "surface",
  "text",
  "muted",
  "accent",
  "border",
] as const;
const roleKeys = ["sidebar", "editor"] as const;
const hexColour = /^#[0-9a-fA-F]{6}$/;
export const presetIdPattern = /^[a-z0-9-]{1,40}$/;

export type ThemeState = { theme: "light" | "dark"; tokens: ThemeTokens | undefined; resolved?: ResolvedTheme };
let themeState: ThemeState = { theme: "light", tokens: undefined };
const themeListeners = new Set<() => void>();
const channel = (value: string, offset: number) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
export function relativeLuminance(value: string): number {
  return 0.2126 * linear(channel(value, 1)) + 0.7152 * linear(channel(value, 3)) + 0.0722 * linear(channel(value, 5));
}
export function contrastRatio(left: string, right: string): number {
  const [lighter, darker] = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}
const betterContrast = (accent: string, left: string, right: string) => contrastRatio(accent, left) >= contrastRatio(accent, right) ? left : right;
export function customPrimaryForeground(tokens: ThemeTokens): string {
  const custom = betterContrast(tokens.accent, tokens.text, tokens.background);
  if (contrastRatio(tokens.accent, custom) >= 4.5) return custom;
  return betterContrast(tokens.accent, "#000000", "#ffffff");
}
export function customSwitchOffForeground(tokens: ThemeTokens): string {
  const custom = betterContrast(tokens.muted, tokens.text, tokens.background);
  if (contrastRatio(tokens.muted, custom) >= 4.5) return custom;
  return betterContrast(tokens.muted, "#000000", "#ffffff");
}
export function customHoverTarget(tokens: ThemeTokens): string {
  const accentLuminance = relativeLuminance(tokens.accent);
  const textLuminance = relativeLuminance(tokens.text);
  if (relativeLuminance(tokens.background) < 0.179) return textLuminance > accentLuminance ? tokens.text : "#ffffff";
  return textLuminance < accentLuminance ? tokens.text : "#000000";
}
const sameThemeState = (left: ThemeState, right: ThemeState) => left.theme === right.theme
  && left.resolved?.key === right.resolved?.key && left.resolved?.presetId === right.resolved?.presetId
  && keys.every(key => left.tokens?.[key] === right.tokens?.[key])
  && roleKeys.every(key => left.tokens?.[key] === right.tokens?.[key])
  && left.tokens?.base === right.tokens?.base;
export const subscribeThemeState = (listener: () => void) => {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
};
const getThemeState = () => themeState;
export function useThemeState(): ThemeState {
  return useSyncExternalStore(subscribeThemeState, getThemeState, getThemeState);
}
export function customTheme(
  settings: Record<string, unknown>,
): ThemeTokens | undefined {
  const selection = settings.themeSelection;
  if (typeof selection !== "string" || !selection.startsWith("custom:"))
    return undefined;
  const themes = settings.customThemes;
  if (!themes || typeof themes !== "object" || Array.isArray(themes))
    return undefined;
  return customTokens((themes as Record<string, unknown>)[selection.slice(7)]);
}
/** Validates one custom theme entry: the six role colours plus the optional `sidebar`, `editor` and `base` keys. */
export function customTokens(value: unknown): ThemeTokens | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const result = {} as ThemeTokens;
  for (const key of keys) {
    const colour = record[key];
    if (typeof colour !== "string" || !hexColour.test(colour)) return undefined;
    result[key] = colour;
  }
  for (const key of roleKeys) {
    const colour = record[key];
    if (colour === undefined) continue;
    if (typeof colour !== "string" || !hexColour.test(colour)) return undefined;
    result[key] = colour;
  }
  const base = record.base;
  if (base !== undefined) {
    if (typeof base !== "string" || !presetIdPattern.test(base)) return undefined;
    result.base = base;
  }
  return result;
}
export function applyThemeTokens(tokens: ThemeTokens | undefined, theme: "light" | "dark", resolved = tokens ? customThemeResolved("current", tokens) : resolveTheme(theme, { systemDark: theme === "dark" })): void {
  const style = document.documentElement.style;
  for (const key of keys) style.removeProperty(`--custom-${key}`);
  style.removeProperty("--custom-primary-fg");
  style.removeProperty("--custom-hover-target");
  style.removeProperty("--custom-switch-off-fg");
  if (tokens) {
    for (const key of keys) style.setProperty(`--custom-${key}`, tokens[key]);
    style.setProperty("--custom-primary-fg", customPrimaryForeground(tokens));
    style.setProperty("--custom-hover-target", customHoverTarget(tokens));
    style.setProperty("--custom-switch-off-fg", customSwitchOffForeground(tokens));
  }
  for (const [key, value] of Object.entries(themeCssVariables(resolved))) style.setProperty(key, value);
  const next = { theme, tokens, resolved };
  if (!sameThemeState(themeState, next)) {
    themeState = next;
    themeListeners.forEach(listener => listener());
  }
}

/** A resolved theme: the concrete palette for the current selection, whatever form the selection took. */
export type ResolvedTheme = {
  /** Effective identity of the path: `preset:<id>` or `custom:<name>` (how it was selected does not matter). */
  key: string;
  name: string;
  mode: "light" | "dark";
  colors: ThemeRoleColors;
  syn: SyntaxColors;
  ansi: AnsiPalette;
  /** The preset the palette/syntax came from (also the base of a custom theme). */
  presetId: string;
  custom: boolean;
};

const threadtermPreset = (systemDark: boolean): ThemePreset =>
  presetById(systemDark ? "threadterm-dark" : "threadterm-light") ?? THEME_PRESETS[0];
const presetTheme = (preset: ThemePreset): ResolvedTheme => ({
  key: `preset:${preset.id}`,
  name: preset.name,
  mode: preset.mode,
  colors: preset.c,
  syn: preset.syn,
  ansi: preset.ansi,
  presetId: preset.id,
  custom: false,
});

/** Resolves a `themeSelection` value into a concrete palette. Unknown or malformed selections never throw: they fall
 * back to ThreadTerm Light/Dark by the OS appearance. */
export function resolveTheme(
  selection: string | undefined,
  options: { systemDark: boolean; customThemes?: Record<string, ThemeTokens> },
): ResolvedTheme {
  const { systemDark } = options;
  const name = typeof selection === "string" ? selection : "";
  if (name.startsWith("preset:"))
    return presetTheme(presetById(name.slice(7)) ?? threadtermPreset(systemDark));
  if (name.startsWith("system:"))
    return presetTheme(familyPreset(name.slice(7), systemDark) ?? threadtermPreset(systemDark));
  if (name.startsWith("custom:")) {
    const customName = name.slice(7);
    const tokens = customTokens(options.customThemes?.[customName]);
    if (tokens) return customThemeResolved(customName, tokens);
  }
  if (name === "light") return presetTheme(threadtermPreset(false));
  if (name === "dark") return presetTheme(threadtermPreset(true));
  return presetTheme(threadtermPreset(systemDark));
}

function customThemeResolved(name: string, tokens: ThemeTokens): ResolvedTheme {
  // An unknown base id is tolerated: fall back to ThreadTerm by the panel's own luminance.
  const fallback = presetById(tokens.base) ?? threadtermPreset(relativeLuminance(tokens.surface) < 0.5);
  return {
    key: `custom:${name}`,
    name,
    mode: fallback.mode,
    colors: {
      frame: tokens.background,
      sidebar: tokens.sidebar ?? tokens.background,
      panel: tokens.surface,
      editor: tokens.editor ?? tokens.surface,
      text: tokens.text,
      muted: tokens.muted,
      border: tokens.border,
      accent: tokens.accent,
      accentFg: customPrimaryForeground(tokens),
      ok: fallback.c.ok,
      warn: fallback.c.warn,
      danger: fallback.c.danger,
    },
    syn: fallback.syn,
    ansi: fallback.ansi,
    presetId: fallback.id,
    custom: true,
  };
}

/** Includes unknown/stale selections whose safe fallback follows the operating system. */
export function themeUsesSystemAppearance(selection: string | undefined, customThemes?: Record<string, ThemeTokens>): boolean {
  return resolveTheme(selection, { systemDark: false, customThemes }).key !== resolveTheme(selection, { systemDark: true, customThemes }).key;
}

/** The CSS custom properties for a resolved theme (root-level tokens only; hover/soft/faint derivatives are CSS
 * `color-mix` of these, and `--st-stalled` stays with the stylesheet because no preset role covers it). */
export function themeCssVariables(resolved: ResolvedTheme): Record<string, string> {
  const { colors, syn } = resolved;
  return {
    "--bg": colors.frame,
    "--side": colors.sidebar,
    "--sidebar": colors.sidebar,
    "--surface": colors.panel,
    "--editor": colors.editor,
    "--text": colors.text,
    "--muted": colors.muted,
    "--border": colors.border,
    "--primary": colors.accent,
    "--primary-fg": colors.accentFg,
    "--amber": colors.warn,
    "--danger": colors.danger,
    "--st-needs": colors.warn,
    "--st-running": colors.ok,
    "--st-failed": colors.danger,
    "--st-ended": colors.muted,
    "--term-bg": colors.editor,
    "--term-fg": colors.text,
    "--syn-keyword": syn.keyword,
    "--syn-string": syn.string,
    "--syn-number": syn.number,
    "--syn-comment": syn.comment,
    "--syn-function": syn.fn,
    "--syn-type": syn.type,
    "--syn-property": syn.prop,
    "--syn-punct": syn.punct,
    "--syn-meta": syn.keyword,
    "--syn-deleted": colors.danger,
  };
}
