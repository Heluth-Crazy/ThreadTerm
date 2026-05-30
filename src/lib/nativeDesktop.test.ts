import { describe, expect, it } from 'vitest';
import {
  detectNativePlatform,
  installNativeDesktopBehavior,
  installWebviewContextMenuPolicy,
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
