import { DEFAULT_THEME_PACK_ID } from '../../theme/themePacks';
import {
  parseCustomThemePack,
  toPortableThemePack,
} from '../../theme/customThemePacks';
import {
  DEFAULT_THEME_MODE,
  isThemeMode,
} from '../../theme/themeStorage';
import type {
  StoredThemePreference,
  ThemeMode,
  ThemePack,
} from '../../theme/themeTypes';
import type { SelectorMode } from '../../stores/overlayStore';
import { readOsNotificationsEnabled } from '../notificationPrefs';

export const SETTINGS_BUNDLE_APP = 'ThreadTerm';
export const SETTINGS_BUNDLE_KIND = 'threadterm-settings-bundle';
export const SETTINGS_BUNDLE_SCHEMA_VERSION = 1;

export const SETTINGS_BUNDLE_SECTION_ORDER = [
  'theme',
  'customThemes',
  'terminal',
  'overlay',
] as const;

export type SettingsBundleSectionId = typeof SETTINGS_BUNDLE_SECTION_ORDER[number];

export interface SettingsBundleThemeSection extends StoredThemePreference {}

export interface SettingsBundleCustomThemesSection {
  packs: ThemePack[];
}

export interface SettingsBundleTerminalSection {
  osNotificationsEnabled: boolean;
}

export interface SettingsBundleOverlaySection {
  selectorMode: SelectorMode;
  hotkeyA: string;
  hotkeyB: string;
  lightweightMode: boolean;
}

export interface SettingsBundleSections {
  theme?: SettingsBundleThemeSection;
  customThemes?: SettingsBundleCustomThemesSection;
  terminal?: SettingsBundleTerminalSection;
  overlay?: SettingsBundleOverlaySection;
}

export interface SettingsBundle {
  app: typeof SETTINGS_BUNDLE_APP;
  kind: typeof SETTINGS_BUNDLE_KIND;
  schemaVersion: typeof SETTINGS_BUNDLE_SCHEMA_VERSION;
  exportedAt: string;
  sections: SettingsBundleSections;
}

export interface SettingsBundleSource {
  exportedAt?: string;
  themePreference?: Partial<StoredThemePreference> | null;
  customThemePacks?: ThemePack[] | null;
  terminalSettings?: Partial<SettingsBundleTerminalSection> | null;
  overlaySettings?: Partial<SettingsBundleOverlaySection> | null;
}

export type SettingsBundleParseResult =
  | { kind: 'success'; bundle: SettingsBundle }
  | { kind: 'error'; message: string };

export type SettingsBundleDiffStatus = 'added' | 'changed' | 'unchanged';

export interface SettingsBundleSectionDiff {
  id: SettingsBundleSectionId;
  status: SettingsBundleDiffStatus;
  currentSummary: string;
  incomingSummary: string;
}

const SELECTOR_MODES = new Set<SelectorMode>(['tile', 'carousel']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function normalizeThemePreference(value: unknown): SettingsBundleThemeSection {
  const record = isRecord(value) ? value : {};
  const themeMode = isThemeMode(record.themeMode) ? record.themeMode : DEFAULT_THEME_MODE;
  const themePackId = optionalString(record.themePackId) ?? DEFAULT_THEME_PACK_ID;
  return { themeMode, themePackId };
}

function normalizeCustomThemePacks(value: unknown): ThemePack[] {
  if (!Array.isArray(value)) return [];

  const packs: ThemePack[] = [];
  for (const item of value) {
    const pack = parseCustomThemePack(JSON.stringify(item));
    packs.push(toPortableThemePack(pack));
  }
  return packs;
}

function normalizeTerminalSettings(value: unknown): SettingsBundleTerminalSection {
  const record = isRecord(value) ? value : {};
  return {
    osNotificationsEnabled: readOsNotificationsEnabled(record),
  };
}

function normalizeOverlaySettings(value: unknown): SettingsBundleOverlaySection {
  const record = isRecord(value) ? value : {};
  return {
    selectorMode: SELECTOR_MODES.has(record.selectorMode as SelectorMode)
      ? (record.selectorMode as SelectorMode)
      : 'tile',
    hotkeyA: optionalString(record.hotkeyA) ?? 'CmdOrCtrl+Shift+Space',
    hotkeyB: optionalString(record.hotkeyB) ?? 'CmdOrCtrl+Shift+O',
    lightweightMode: record.lightweightMode === true,
  };
}

export function normalizeBundleCustomThemePacks(packs: ThemePack[]): ThemePack[] {
  return packs.map((pack) => parseCustomThemePack(JSON.stringify(pack)));
}

export function createSettingsBundle(source: SettingsBundleSource = {}): SettingsBundle {
  const customThemePacks = normalizeCustomThemePacks(source.customThemePacks ?? []);

  return {
    app: SETTINGS_BUNDLE_APP,
    kind: SETTINGS_BUNDLE_KIND,
    schemaVersion: SETTINGS_BUNDLE_SCHEMA_VERSION,
    exportedAt: source.exportedAt ?? new Date().toISOString(),
    sections: {
      theme: normalizeThemePreference(source.themePreference),
      customThemes: { packs: customThemePacks },
      terminal: normalizeTerminalSettings(source.terminalSettings),
      overlay: normalizeOverlaySettings(source.overlaySettings),
    },
  };
}

export function stringifySettingsBundle(bundle: SettingsBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function getSettingsBundleExportFilename(date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10);
  return `threadterm-settings-${stamp}.threadterm-settings.json`;
}

export function parseSettingsBundle(json: string): SettingsBundleParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { kind: 'error', message: 'Settings file is not valid JSON.' };
  }

  try {
    if (!isRecord(parsed)) {
      throw new Error('Settings file must contain an object.');
    }
    if (parsed.app !== SETTINGS_BUNDLE_APP || parsed.kind !== SETTINGS_BUNDLE_KIND) {
      throw new Error('Settings file is not a ThreadTerm settings bundle.');
    }
    if (parsed.schemaVersion !== SETTINGS_BUNDLE_SCHEMA_VERSION) {
      throw new Error(`Unsupported settings bundle version: ${String(parsed.schemaVersion)}.`);
    }
    if (!isRecord(parsed.sections)) {
      throw new Error('Settings bundle is missing sections.');
    }

    const sections: SettingsBundleSections = {};
    if (parsed.sections.theme !== undefined) {
      sections.theme = normalizeThemePreference(parsed.sections.theme);
    }
    if (parsed.sections.customThemes !== undefined) {
      const customThemes = isRecord(parsed.sections.customThemes)
        ? parsed.sections.customThemes.packs
        : [];
      sections.customThemes = { packs: normalizeCustomThemePacks(customThemes) };
    }
    if (parsed.sections.terminal !== undefined) {
      sections.terminal = normalizeTerminalSettings(parsed.sections.terminal);
    }
    if (parsed.sections.overlay !== undefined) {
      sections.overlay = normalizeOverlaySettings(parsed.sections.overlay);
    }

    return {
      kind: 'success',
      bundle: {
        app: SETTINGS_BUNDLE_APP,
        kind: SETTINGS_BUNDLE_KIND,
        schemaVersion: SETTINGS_BUNDLE_SCHEMA_VERSION,
        exportedAt: optionalString(parsed.exportedAt) ?? new Date(0).toISOString(),
        sections,
      },
    };
  } catch (error) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (!isRecord(value)) return value;
  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = comparable(value[key]);
      return acc;
    }, {});
}

function sameSection(a: unknown, b: unknown): boolean {
  return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}

export function summarizeSettingsBundleSection(
  bundle: SettingsBundle,
  id: SettingsBundleSectionId,
): string {
  switch (id) {
    case 'theme': {
      const section = bundle.sections.theme;
      if (!section) return 'Not set';
      return `${section.themeMode} / ${section.themePackId}`;
    }
    case 'customThemes': {
      const section = bundle.sections.customThemes;
      if (!section) return 'Not set';
      return `${section.packs.length} custom theme${section.packs.length === 1 ? '' : 's'}`;
    }
    case 'terminal': {
      const section = bundle.sections.terminal;
      if (!section) return 'Not set';
      return `notifications ${section.osNotificationsEnabled ? 'on' : 'off'}`;
    }
    case 'overlay': {
      const section = bundle.sections.overlay;
      if (!section) return 'Not set';
      return `${section.selectorMode}, A ${section.hotkeyA}, B ${section.hotkeyB}, lightweight ${
        section.lightweightMode ? 'on' : 'off'
      }`;
    }
    default:
      return 'Not set';
  }
}

export function buildSettingsBundleDiff(
  current: SettingsBundle,
  incoming: SettingsBundle,
): SettingsBundleSectionDiff[] {
  return SETTINGS_BUNDLE_SECTION_ORDER.flatMap((id) => {
    const incomingSection = incoming.sections[id];
    if (incomingSection === undefined) return [];
    const currentSection = current.sections[id];
    const status: SettingsBundleDiffStatus =
      currentSection === undefined
        ? 'added'
        : sameSection(currentSection, incomingSection)
          ? 'unchanged'
          : 'changed';

    return [
      {
        id,
        status,
        currentSummary: summarizeSettingsBundleSection(current, id),
        incomingSummary: summarizeSettingsBundleSection(incoming, id),
      },
    ];
  });
}

export function getDefaultSelectedSettingsSections(
  diffs: SettingsBundleSectionDiff[],
): SettingsBundleSectionId[] {
  return diffs
    .filter((diff) => diff.status !== 'unchanged')
    .map((diff) => diff.id);
}

export function isSettingsBundleSectionId(value: string): value is SettingsBundleSectionId {
  return SETTINGS_BUNDLE_SECTION_ORDER.includes(value as SettingsBundleSectionId);
}


export function isThemePreferenceMode(value: unknown): value is ThemeMode {
  return isThemeMode(value);
}
