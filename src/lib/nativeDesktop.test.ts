import { describe, expect, it, vi } from 'vitest';
import {
  detectNativePlatform,
  installChromeTextSelectionPolicy,
  installNativeDesktopBehavior,
  installOverlayKeepWarmLoop,
  installWebviewContextMenuPolicy,
  resolveInitialPlatformMaterial,
  shouldAllowWebviewContextMenu,
} from './nativeDesktop';

describe('native desktop platform helpers', () => {
  it('normalizes common desktop platforms', () => {
    expect(detectNativePlatform({ platform: 'MacIntel' })).toBe('macos');
    expect(detectNativePlatform({ platform: 'Win32' })).toBe('windows');
    expect(detectNativePlatform({ platform: 'Linux x86_64' })).toBe('linux');
    expect(detectNativePlatform({ platform: 'Plan9' })).toBe('unknown');
  });
});

describe('initial platform material decision', () => {
  it('defaults enabled on macOS and disabled on Windows when env is unset', () => {
    expect(resolveInitialPlatformMaterial('macos', undefined)).toBe(true);
    expect(resolveInitialPlatformMaterial('windows', undefined)).toBe(false);
  });

  it('macOS stays enabled for explicit enable or unknown env tokens', () => {
    for (const value of ['1', 'true', 'on', 'yes', 'anything']) {
      expect(resolveInitialPlatformMaterial('macos', value)).toBe(true);
    }
  });

  it('Windows enables only on explicit enable tokens', () => {
    for (const value of ['1', 'true', 'on', 'yes', ' YES ']) {
      expect(resolveInitialPlatformMaterial('windows', value)).toBe(true);
    }
    for (const value of ['anything', 'material', '']) {
      expect(resolveInitialPlatformMaterial('windows', value)).toBe(false);
    }
  });

  it('disables on explicit disable tokens', () => {
    for (const value of ['0', 'false', 'off', 'no', ' OFF ']) {
      expect(resolveInitialPlatformMaterial('macos', value)).toBe(false);
      expect(resolveInitialPlatformMaterial('windows', value)).toBe(false);
    }
  });

  it('stays disabled on unsupported platforms regardless of env', () => {
    expect(resolveInitialPlatformMaterial('linux', undefined)).toBe(false);
    expect(resolveInitialPlatformMaterial('linux', '1')).toBe(false);
    expect(resolveInitialPlatformMaterial('unknown', 'true')).toBe(false);
  });
});

describe('webview context menu policy', () => {
  it('keeps platform material disabled unless explicitly enabled by the main window', () => {
    const doc = document.implementation.createHTMLDocument();
    const cleanup = installNativeDesktopBehavior(doc, { platformMaterial: false });

    cleanup();
    expect(doc.documentElement.dataset.platformMaterial).toBe('disabled');
  });

  it('allows editing and terminal surfaces', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    const terminal = document.createElement('div');

    editable.setAttribute('contenteditable', 'true');
    terminal.className = 'threadterm-xterm-host';

    expect(shouldAllowWebviewContextMenu(input)).toBe(true);
    expect(shouldAllowWebviewContextMenu(textarea)).toBe(true);
    expect(shouldAllowWebviewContextMenu(editable)).toBe(true);
    expect(shouldAllowWebviewContextMenu(terminal)).toBe(true);
  });

  it('blocks ordinary chrome so the browser menu does not leak through', () => {
    const doc = document.implementation.createHTMLDocument();
    const cleanup = installWebviewContextMenuPolicy(doc);
    const row = doc.createElement('div');
    doc.body.appendChild(row);

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    row.dispatchEvent(event);

    cleanup();
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not block whitelisted input context menus', () => {
    const doc = document.implementation.createHTMLDocument();
    const cleanup = installWebviewContextMenuPolicy(doc);
    const input = doc.createElement('input');
    doc.body.appendChild(input);

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    input.dispatchEvent(event);

    cleanup();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('native chrome text and spelling policy', () => {
  it('marks desktop chrome as non-selectable at the document root', () => {
    const doc = document.implementation.createHTMLDocument();
    const cleanup = installChromeTextSelectionPolicy(doc);

    expect(doc.documentElement.dataset.nativeTextSelection).toBe('chrome');

    cleanup();
    expect(doc.documentElement.dataset.nativeTextSelection).toBeUndefined();
  });

  it('disables spellcheck on mounted text editors without overriding explicit opt-in', async () => {
    const doc = document.implementation.createHTMLDocument();
    const input = doc.createElement('input');
    const checkbox = doc.createElement('input');
    const explicit = doc.createElement('input');

    checkbox.type = 'checkbox';
    explicit.setAttribute('spellcheck', 'true');
    doc.body.append(input, checkbox, explicit);

    const cleanup = installNativeDesktopBehavior(doc, { platformMaterial: false });

    expect(doc.documentElement.getAttribute('spellcheck')).toBe('false');
    expect(doc.body.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(checkbox.hasAttribute('spellcheck')).toBe(false);
    expect(explicit.getAttribute('spellcheck')).toBe('true');

    const lateInput = doc.createElement('input');
    doc.body.append(lateInput);
    await Promise.resolve();

    cleanup();
    expect(lateInput.getAttribute('spellcheck')).toBe('false');
  });
});

describe('overlay render-loop keep-warm', () => {
  function makeHost() {
    const callbacks: FrameRequestCallback[] = [];
    const host = {
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
      }),
      cancelAnimationFrame: vi.fn(),
    };
    return { callbacks, host };
  }

  function makeDoc(initial: DocumentVisibilityState): Document {
    const doc = document.implementation.createHTMLDocument();
    let visibility = initial;
    Object.defineProperty(doc, 'visibilityState', {
      get: () => visibility,
      configurable: true,
    });
    (doc as Document & { setVisibility: (v: DocumentVisibilityState) => void }).setVisibility = (
      v,
    ) => {
      visibility = v;
      doc.dispatchEvent(new Event('visibilitychange'));
    };
    return doc;
  }

  it('schedules no-op animation frames while visible until cleanup', () => {
    const { callbacks, host } = makeHost();
    const doc = makeDoc('visible');

    const cleanup = installOverlayKeepWarmLoop(host, doc);

    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(1);
    callbacks[0](0);
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(2);

    cleanup();
    expect(host.cancelAnimationFrame).toHaveBeenCalledWith(2);
    callbacks[1](16);
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(2);
  });

  it('does not start while hidden and pauses/resumes with visibility', () => {
    const { callbacks, host } = makeHost();
    const doc = makeDoc('hidden');
    const setVisibility = (doc as Document & {
      setVisibility: (v: DocumentVisibilityState) => void;
    }).setVisibility;

    const cleanup = installOverlayKeepWarmLoop(host, doc);
    expect(host.requestAnimationFrame).not.toHaveBeenCalled();

    setVisibility('visible');
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(1);
    callbacks[0](0);
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(2);

    setVisibility('hidden');
    expect(host.cancelAnimationFrame).toHaveBeenCalledWith(2);
    callbacks[1](16);
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(2);

    setVisibility('visible');
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(3);

    cleanup();
    expect(host.cancelAnimationFrame).toHaveBeenCalledWith(3);
    setVisibility('visible');
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(3);
  });
});
