import { isTauriEnv } from './tauri-bridge';
import { readOsNotificationsEnabled } from './notificationPrefs';
import type { StoredThemePreference, ThemePack } from '../theme/themeTypes';

export const SETTINGS_CHANGED_EVENT = 'settings://changed';
export const SETTINGS_LOCAL_CHANGED_EVENT = 'threadterm-settings-changed';

export type SettingsChangeDomain =
  | 'theme'
  | 'language'
  | 'terminal-preferences'
  | 'overlay-preferences'
  | 'all';

export interface ThemeSettingsSnapshot {
  preference?: StoredThemePreference;
  customThemePacks?: ThemePack[];
}

export interface TerminalPreferenceSnapshot {
  osNotificationsEnabled: boolean;
  osNotificationPreviewEnabled?: boolean;
  agentCliCompatibilityCompletionEnabled?: boolean;
  supervisorEnabled: boolean;
}

export interface OverlayPreferenceSnapshot {
  selectorMode: 'tile' | 'carousel';
  hotkeyA: string;
  hotkeyB: string;
  lightweightMode: boolean;
}

export interface SettingsChangedPayload {
  domain: SettingsChangeDomain;
  changedAt: number;
  language?: string;
  sourceWindow?: string;
  theme?: ThemeSettingsSnapshot;
  terminalPreferences?: TerminalPreferenceSnapshot;
  overlayPreferences?: OverlayPreferenceSnapshot;
}

export type SettingsChangeInput = Omit<SettingsChangedPayload, 'changedAt'> & {
  changedAt?: number;
};

const SETTINGS_CHANGE_DOMAINS = new Set<SettingsChangeDomain>([
  'theme',
  'language',
  'terminal-preferences',
  'overlay-preferences',
  'all',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeThemeSnapshot(value: unknown): ThemeSettingsSnapshot | undefined {
  if (!isRecord(value)) return undefined;

  const preference = isRecord(value.preference)
    && typeof value.preference.themeMode === 'string'
    && typeof value.preference.themePackId === 'string'
    ? {
        themeMode: value.preference.themeMode as StoredThemePreference['themeMode'],
        themePackId: value.preference.themePackId,
      }
    : undefined;
  const customThemePacks = Array.isArray(value.customThemePacks)
    ? (value.customThemePacks as ThemePack[])
    : undefined;

  if (!preference && !customThemePacks) return undefined;
  return { preference, customThemePacks };
}

function normalizeTerminalPreferences(value: unknown): TerminalPreferenceSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.supervisorEnabled !== 'boolean'
  ) {
    return undefined;
  }

  return {
    osNotificationsEnabled: readOsNotificationsEnabled(value),
    osNotificationPreviewEnabled:
      typeof value.osNotificationPreviewEnabled === 'boolean'
        ? value.osNotificationPreviewEnabled
        : true,
    agentCliCompatibilityCompletionEnabled:
      typeof value.agentCliCompatibilityCompletionEnabled === 'boolean'
        ? value.agentCliCompatibilityCompletionEnabled
        : true,
    supervisorEnabled: value.supervisorEnabled,
  };
}

function normalizeOverlayPreferences(value: unknown): OverlayPreferenceSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (
    (value.selectorMode !== 'tile' && value.selectorMode !== 'carousel')
    || typeof value.hotkeyA !== 'string'
    || typeof value.hotkeyB !== 'string'
  ) {
    return undefined;
  }

  return {
    selectorMode: value.selectorMode,
    hotkeyA: value.hotkeyA,
    hotkeyB: value.hotkeyB,
    lightweightMode: value.lightweightMode === true,
  };
}

export function createSettingsChangedPayload(input: SettingsChangeInput): SettingsChangedPayload {
  return {
    ...input,
    changedAt: input.changedAt ?? Date.now(),
  };
}

export function normalizeSettingsChangedPayload(value: unknown): SettingsChangedPayload | null {
  if (!isRecord(value) || !SETTINGS_CHANGE_DOMAINS.has(value.domain as SettingsChangeDomain)) {
    return null;
  }

  return {
    domain: value.domain as SettingsChangeDomain,
    changedAt:
      typeof value.changedAt === 'number' && Number.isFinite(value.changedAt)
        ? value.changedAt
        : Date.now(),
    language: typeof value.language === 'string' ? value.language : undefined,
    sourceWindow: typeof value.sourceWindow === 'string' ? value.sourceWindow : undefined,
    theme: normalizeThemeSnapshot(value.theme),
    terminalPreferences: normalizeTerminalPreferences(value.terminalPreferences),
    overlayPreferences: normalizeOverlayPreferences(value.overlayPreferences),
  };
}

function dispatchLocalSettingsChanged(payload: SettingsChangedPayload) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<SettingsChangedPayload>(SETTINGS_LOCAL_CHANGED_EVENT, { detail: payload }),
  );
}

export async function emitSettingsChanged(input: SettingsChangeInput): Promise<void> {
  const payload = createSettingsChangedPayload(input);
  dispatchLocalSettingsChanged(payload);

  if (!isTauriEnv()) return;

  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(SETTINGS_CHANGED_EVENT, payload);
  } catch (error) {
    console.debug('[settings] failed to emit settings change event', error);
  }
}

export function listenSettingsChanged(
  handler: (payload: SettingsChangedPayload) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};

  let disposed = false;
  let unlistenTauri: (() => void) | null = null;

  const handlePayload = (value: unknown) => {
    const payload = normalizeSettingsChangedPayload(value);
    if (payload) handler(payload);
  };

  const handleLocal = (event: Event) => {
    handlePayload((event as CustomEvent<unknown>).detail);
  };

  window.addEventListener(SETTINGS_LOCAL_CHANGED_EVENT, handleLocal);

  if (isTauriEnv()) {
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<unknown>(SETTINGS_CHANGED_EVENT, (event) => handlePayload(event.payload)))
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenTauri = unlisten;
        }
      })
      .catch((error) => {
        console.debug('[settings] failed to listen for settings change events', error);
      });
  }

  return () => {
    disposed = true;
    window.removeEventListener(SETTINGS_LOCAL_CHANGED_EVENT, handleLocal);
    unlistenTauri?.();
  };
}
