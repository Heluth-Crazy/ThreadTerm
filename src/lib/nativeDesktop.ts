import { invoke, isTauriEnv } from './tauri-bridge';

export type NativePlatform = 'macos' | 'windows' | 'linux' | 'unknown';

export interface PlatformMaterialState {
  enabled: boolean;
  platform: NativePlatform;
}

interface PlatformSource {
  platform?: string;
  userAgent?: string;
  userAgentData?: {
    platform?: string;
  };
}

const TERMINAL_CONTEXT_MENU_SELECTOR = [
  '.threadterm-xterm-host',
  '.xterm',
  '.xterm-viewport',
  '.xterm-screen',
  '[data-terminal-context-menu]',
].join(',');

function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

export function detectNativePlatform(source: PlatformSource = navigator as PlatformSource): NativePlatform {
  const platformText = [
    source.userAgentData?.platform,
    source.platform,
    source.userAgent,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (platformText.includes('mac')) return 'macos';
  if (platformText.includes('win')) return 'windows';
  if (platformText.includes('linux')) return 'linux';
  return 'unknown';
}

export function writeNativePlatformAttribute(root: HTMLElement = document.documentElement): NativePlatform {
  const platform = detectNativePlatform();
  root.dataset.platform = platform;
  return platform;
}

function initialPlatformMaterialEnabled(): boolean {
  const platform = detectNativePlatform();
  return (
    envFlagEnabled(import.meta.env.VITE_THREADTERM_PLATFORM_MATERIAL) &&
    (platform === 'macos' || platform === 'windows')
  );
}

export function writeInitialPlatformMaterialAttribute(
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.platformMaterial = initialPlatformMaterialEnabled() ? 'enabled' : 'disabled';
}

export async function syncPlatformMaterialAttribute(
  root: HTMLElement = document.documentElement,
): Promise<void> {
  if (!isTauriEnv()) {
    return;
  }

  try {
    const state = await invoke<PlatformMaterialState>('native_platform_material_state');
    root.dataset.platformMaterial = state.enabled ? 'enabled' : 'disabled';
    root.dataset.platformMaterialPlatform = state.platform;
  } catch {
    root.dataset.platformMaterial = 'disabled';
  }
}

function elementFromTarget(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (typeof Node !== 'undefined' && target instanceof Node) return target.parentElement;
  return null;
}

function hasEditableContextMenu(element: Element): boolean {
  const editable = element.closest('input, textarea, [contenteditable]');
  if (!editable) return false;

  if (editable instanceof HTMLInputElement) return !editable.disabled;
  if (editable instanceof HTMLTextAreaElement) return !editable.disabled;

  const contentEditable = editable.getAttribute('contenteditable');
  return contentEditable !== null && contentEditable.toLowerCase() !== 'false';
}

export function shouldAllowWebviewContextMenu(target: EventTarget | null): boolean {
  const element = elementFromTarget(target);
  if (!element) return false;

  return (
    hasEditableContextMenu(element) ||
    Boolean(element.closest(TERMINAL_CONTEXT_MENU_SELECTOR))
  );
}

export function installWebviewContextMenuPolicy(doc: Document = document): () => void {
  const onContextMenu = (event: MouseEvent) => {
    if (!shouldAllowWebviewContextMenu(event.target)) {
      event.preventDefault();
    }
  };

  doc.addEventListener('contextmenu', onContextMenu, true);
  return () => doc.removeEventListener('contextmenu', onContextMenu, true);
}

interface NativeDesktopBehaviorOptions {
  platformMaterial?: boolean;
}

export function installNativeDesktopBehavior(
  doc: Document = document,
  options: NativeDesktopBehaviorOptions = {},
): () => void {
  writeNativePlatformAttribute(doc.documentElement);
  if (options.platformMaterial) {
    writeInitialPlatformMaterialAttribute(doc.documentElement);
    void syncPlatformMaterialAttribute(doc.documentElement);
  } else {
    doc.documentElement.dataset.platformMaterial = 'disabled';
  }
  return installWebviewContextMenuPolicy(doc);
}
