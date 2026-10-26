import { familyById, presetById, THEME_FAMILIES, type ThemeMode, type ThemePreset } from "./themePresets";
import type { ThemeTokens } from "./themes";

export type AppearanceMode = "system" | ThemeMode;

function familyForPreset(id: string | undefined) {
  return THEME_FAMILIES.find(family => family.light === id || family.dark === id);
}

/** The family represented by a saved selection, including a custom theme's optional preset base. */
export function familyForSelection(selection: string | undefined, customThemes?: Record<string, ThemeTokens>) {
  if (selection === "light" || selection === "dark" || selection === "system" || !selection) return familyById("threadterm");
  if (selection.startsWith("system:")) return familyById(selection.slice(7)) ?? familyById("threadterm");
  if (selection.startsWith("preset:")) return familyForPreset(selection.slice(7)) ?? familyById("threadterm");
  if (selection.startsWith("custom:")) return familyForPreset(customThemes?.[selection.slice(7)]?.base) ?? familyById("threadterm");
  return familyById("threadterm");
}

/** The picker mode represented by a built-in selection. Custom themes have no mode control selected. */
export function appearanceModeForSelection(selection: string | undefined): AppearanceMode | undefined {
  if (selection === "light" || selection === "dark") return selection;
  if (selection?.startsWith("preset:")) return presetById(selection.slice(7))?.mode ?? "system";
  if (selection === "system" || selection?.startsWith("system:")) return "system";
  return undefined;
}

/** Returns the stored selection for a family's quick mode, retaining legacy ThreadTerm values. */
export function selectionForFamilyMode(familyId: string | undefined, mode: AppearanceMode): string {
  const family = familyById(familyId) ?? familyById("threadterm");
  if (!family) return mode;
  if (family.id === "threadterm") return mode;
  if (mode === "system" && family.light && family.dark) return `system:${family.id}`;
  const presetId = mode === "light" ? family.light ?? "threadterm-light" : family.dark ?? family.light ?? "threadterm-dark";
  return `preset:${presetId}`;
}

/** Selecting a card while in System keeps a paired family following the operating system. */
export function selectionForPreset(preset: ThemePreset, mode: AppearanceMode): string {
  const family = familyForPreset(preset.id);
  return mode === "system" && family?.light && family.dark ? selectionForFamilyMode(family.id, mode) : `preset:${preset.id}`;
}

/** Whether a card is the concrete palette currently selected for the operating-system appearance. */
export function isPresetSelected(selection: string | undefined, preset: ThemePreset, systemDark: boolean): boolean {
  if (selection === "light") return preset.id === "threadterm-light";
  if (selection === "dark") return preset.id === "threadterm-dark";
  if (selection === "system" || !selection) return preset.id === (systemDark ? "threadterm-dark" : "threadterm-light");
  if (selection === `preset:${preset.id}`) return true;
  if (!selection.startsWith("system:")) return false;
  const family = familyById(selection.slice(7));
  return preset.id === (systemDark ? family?.dark ?? family?.light : family?.light ?? family?.dark);
}
