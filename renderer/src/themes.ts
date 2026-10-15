import { useSyncExternalStore } from "react";

export type ThemeTokens = {
  background: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
};
const keys = [
  "background",
  "surface",
  "text",
  "muted",
  "accent",
  "border",
] as const;

export type ThemeState = { theme: "light" | "dark"; tokens: ThemeTokens | undefined };
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
  && keys.every(key => left.tokens?.[key] === right.tokens?.[key]);
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
  const tokens = (themes as Record<string, unknown>)[selection.slice(7)];
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens))
    return undefined;
  const result = {} as ThemeTokens;
  for (const key of keys) {
    const value = (tokens as Record<string, unknown>)[key];
    if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value))
      return undefined;
    result[key] = value;
  }
  return result;
}
export function applyThemeTokens(tokens: ThemeTokens | undefined, theme: "light" | "dark"): void {
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
  const next = { theme, tokens };
  if (!sameThemeState(themeState, next)) {
    themeState = next;
    themeListeners.forEach(listener => listener());
  }
}
