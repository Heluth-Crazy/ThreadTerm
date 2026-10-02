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
export function applyThemeTokens(tokens: ThemeTokens | undefined): void {
  const style = document.documentElement.style;
  for (const key of keys) style.removeProperty(`--custom-${key}`);
  if (!tokens) return;
  for (const key of keys) style.setProperty(`--custom-${key}`, tokens[key]);
}
