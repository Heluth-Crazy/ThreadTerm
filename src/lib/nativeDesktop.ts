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

const TEXT_EDITING_SELECTOR = 'input, textarea, [contenteditable]';

const INPUT_TYPES_WITHOUT_SPELLCHECK = new Set([
  'button',
  'checkbox',
  'color',
  'date',
  'datetime-local',
  'file',
  'hidden',
  'image',
  'month',
  'number',
  'radio',
  'range',
  'reset',
  'submit',
  'time',
  'week',
]);

function envValueDisables(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no';
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

/**
 * Pure first-paint material decision. Material defaults ON for supported
 * platforms (macOS/Windows) so the initial `data-platform-material` attribute
 * matches the backend's default-on state and avoids a white-flash before
 * `syncPlatformMaterialAttribute()` confirms. Disable only when the env value is
 * an explicit disable token (mirrors Rust `material_enabled_from_env`).
 */
export function resolveInitialPlatformMaterial(
  platform: NativePlatform,
  envValue: string | undefined,
): boolean {
  if (platform !== 'macos' && platform !== 'windows') {
    return false;
  }
  return !envValueDisables(envValue);
}

function initialPlatformMaterialEnabled(): boolean {
  return resolveInitialPlatformMaterial(
    detectNativePlatform(),
    import.meta.env.VITE_THREADTERM_PLATFORM_MATERIAL,
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

export function installChromeTextSelectionPolicy(doc: Document = document): () => void {
  const root = doc.documentElement;
  const previous = root.getAttribute('data-native-text-selection');

  root.dataset.nativeTextSelection = 'chrome';

  return () => {
    if (previous === null) {
      delete root.dataset.nativeTextSelection;
    } else {
      root.setAttribute('data-native-text-selection', previous);
    }
  };
}

function shouldDisableSpellcheckByDefault(element: Element): boolean {
  if (element.hasAttribute('spellcheck')) {
    return false;
  }

  if (element instanceof HTMLInputElement) {
    return !INPUT_TYPES_WITHOUT_SPELLCHECK.has(element.type.toLowerCase());
  }

  if (element instanceof HTMLTextAreaElement) {
    return true;
  }

  const contentEditable = element.getAttribute('contenteditable');
  return contentEditable !== null && contentEditable.toLowerCase() !== 'false';
}

function disableSpellcheckByDefault(element: Element): void {
  if (!shouldDisableSpellcheckByDefault(element)) {
    return;
  }
  element.setAttribute('spellcheck', 'false');
  if ('spellcheck' in element) {
    (element as HTMLElement).spellcheck = false;
  }
}

function applySpellcheckDefaults(root: ParentNode): void {
  if (root instanceof Element) {
    disableSpellcheckByDefault(root);
  }
  root.querySelectorAll(TEXT_EDITING_SELECTOR).forEach(disableSpellcheckByDefault);
}

export function installWebviewSpellcheckPolicy(doc: Document = document): () => void {
  const root = doc.documentElement;
  const body = doc.body;
  const previousRoot = root.getAttribute('spellcheck');
  const previousBody = body?.getAttribute('spellcheck') ?? null;

  root.spellcheck = false;
  root.setAttribute('spellcheck', 'false');
  if (body) {
    body.spellcheck = false;
    body.setAttribute('spellcheck', 'false');
  }

  applySpellcheckDefaults(doc);

  const MutationObserverCtor = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  if (!MutationObserverCtor) {
    return () => {
      if (previousRoot === null) root.removeAttribute('spellcheck');
      else root.setAttribute('spellcheck', previousRoot);
      if (body) {
        if (previousBody === null) body.removeAttribute('spellcheck');
        else body.setAttribute('spellcheck', previousBody);
      }
    };
  }

  const observer = new MutationObserverCtor((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          applySpellcheckDefaults(node as Element);
        }
      });
    }
  });
  observer.observe(root, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    if (previousRoot === null) root.removeAttribute('spellcheck');
    else root.setAttribute('spellcheck', previousRoot);
    if (body) {
      if (previousBody === null) body.removeAttribute('spellcheck');
      else body.setAttribute('spellcheck', previousBody);
    }
  };
}

type AnimationFrameHost = Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>;

export function installOverlayKeepWarmLoop(host: AnimationFrameHost = window): () => void {
  let active = true;
  let frameId = 0;

  const tick: FrameRequestCallback = () => {
    if (!active) return;
    frameId = host.requestAnimationFrame(tick);
  };

  frameId = host.requestAnimationFrame(tick);

  return () => {
    active = false;
    host.cancelAnimationFrame(frameId);
  };
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

  const cleanups = [
    installChromeTextSelectionPolicy(doc),
    installWebviewSpellcheckPolicy(doc),
    installWebviewContextMenuPolicy(doc),
  ];

  return () => {
    for (const cleanup of cleanups.reverse()) {
      cleanup();
    }
  };
}
