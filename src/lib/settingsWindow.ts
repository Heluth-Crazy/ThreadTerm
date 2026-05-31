import { isTauriEnv } from './tauri-bridge';

export const SETTINGS_WINDOW_LABEL = 'settings';
export const SETTINGS_OPEN_EVENT = 'settings://open';
export const SETTINGS_TABS = ['appearance', 'shortcuts', 'supervisor', 'data'] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

export interface SettingsOpenPayload {
  tab: SettingsTab;
}

export interface SettingsWindowCreateOptions {
  url: string;
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  resizable: boolean;
  decorations: boolean;
  transparent: boolean;
  center: boolean;
  visible: boolean;
  focus: boolean;
  skipTaskbar: boolean;
}

export interface SettingsWindowHandle {
  show: () => Promise<void>;
  unminimize: () => Promise<void>;
  setFocus: () => Promise<void>;
  once: <T = unknown>(
    event: string,
    handler: (event: { payload: T }) => void,
  ) => Promise<() => void>;
}

export interface SettingsWindowAdapters {
  getExistingWindow: () => Promise<SettingsWindowHandle | null>;
  createWindow: (options: SettingsWindowCreateOptions) => SettingsWindowHandle;
  emitTo: (target: string, event: string, payload: SettingsOpenPayload) => Promise<void>;
  openBrowserWindow?: (url: string) => boolean;
}

export const SETTINGS_WINDOW_BASE_OPTIONS = {
  title: 'ThreadTerm Settings',
  width: 960,
  height: 720,
  minWidth: 760,
  minHeight: 520,
  resizable: true,
  decorations: true,
  transparent: false,
  center: true,
  visible: true,
  focus: true,
  skipTaskbar: false,
} as const;

export function normalizeSettingsTab(tab: unknown): SettingsTab {
  return SETTINGS_TABS.includes(tab as SettingsTab) ? (tab as SettingsTab) : 'shortcuts';
}

export function buildSettingsWindowUrl(tab: unknown): string {
  return `settings.html?tab=${encodeURIComponent(normalizeSettingsTab(tab))}`;
}

export function normalizeSettingsOpenPayload(payload: unknown): SettingsOpenPayload {
  if (typeof payload === 'object' && payload !== null && 'tab' in payload) {
    return { tab: normalizeSettingsTab((payload as { tab?: unknown }).tab) };
  }
  return { tab: normalizeSettingsTab(payload) };
}

async function focusSettingsWindow(windowHandle: SettingsWindowHandle): Promise<void> {
  await windowHandle.show().catch(() => {});
  await windowHandle.unminimize().catch(() => {});
  await windowHandle.setFocus().catch(() => {});
}

export async function openSettingsWindowWithAdapters(
  tabInput: unknown,
  adapters: SettingsWindowAdapters,
): Promise<boolean> {
  const tab = normalizeSettingsTab(tabInput);
  const existing = await adapters.getExistingWindow();

  if (existing) {
    await adapters.emitTo(SETTINGS_WINDOW_LABEL, SETTINGS_OPEN_EVENT, { tab }).catch((error) => {
      console.debug('[settings] failed to route settings tab', error);
    });
    await focusSettingsWindow(existing);
    return true;
  }

  const options: SettingsWindowCreateOptions = {
    ...SETTINGS_WINDOW_BASE_OPTIONS,
    url: buildSettingsWindowUrl(tab),
  };

  try {
    const created = adapters.createWindow(options);
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      void created.once('tauri://created', () => {
        void focusSettingsWindow(created).finally(() => settle(true));
      });
      void created.once('tauri://error', (event) => {
        console.warn('[settings] failed to create settings window', event.payload);
        settle(false);
      });
    });
  } catch (error) {
    console.warn('[settings] failed to create settings window', error);
    return false;
  }
}

function openBrowserSettingsWindow(tab: unknown): boolean {
  if (typeof window === 'undefined') return false;
  const opened = window.open(
    buildSettingsWindowUrl(tab),
    SETTINGS_WINDOW_LABEL,
    'width=960,height=720,resizable=yes,scrollbars=yes',
  );
  opened?.focus?.();
  return Boolean(opened);
}

async function getTauriSettingsWindowAdapters(): Promise<SettingsWindowAdapters> {
  const [{ WebviewWindow }, { emitTo }] = await Promise.all([
    import('@tauri-apps/api/webviewWindow'),
    import('@tauri-apps/api/event'),
  ]);

  return {
    getExistingWindow: () =>
      WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL) as Promise<SettingsWindowHandle | null>,
    createWindow: (options) =>
      new WebviewWindow(SETTINGS_WINDOW_LABEL, options) as SettingsWindowHandle,
    emitTo: (target, event, payload) => emitTo(target, event, payload),
  };
}

export async function openSettingsWindow(tab: unknown = 'shortcuts'): Promise<boolean> {
  if (!isTauriEnv()) {
    return openBrowserSettingsWindow(tab);
  }

  const adapters = await getTauriSettingsWindowAdapters();
  return openSettingsWindowWithAdapters(tab, adapters);
}
