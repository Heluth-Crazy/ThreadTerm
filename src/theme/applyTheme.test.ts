import { beforeEach, describe, expect, it } from 'vitest';
import { applyResolvedTheme, hexToHslToken, resolveTheme } from './applyTheme';

describe('applyResolvedTheme', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#ffffff" />';
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme-pack');
    document.documentElement.style.cssText = '';
  });

  it('writes Acme Mono theme metadata and CSS variables to the root element', () => {
    const resolved = resolveTheme('acme-mono', 'dark');

    applyResolvedTheme(resolved);

    expect(document.documentElement.dataset.themePack).toBe('acme-mono');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--background')).toBe(
      hexToHslToken(resolved.tokens.app.background),
    );
    expect(document.documentElement.style.getPropertyValue('--terminal-background')).toBe(
      resolved.tokens.terminal.background,
    );
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      resolved.tokens.app.background,
    );
  });

  it('clears a previously-set terminal variable when the new theme lacks that token', () => {
    const base = resolveTheme('acme-mono', 'dark');
    applyResolvedTheme(base);
    expect(document.documentElement.style.getPropertyValue('--terminal-selection')).toBe(
      base.tokens.terminal.selection,
    );

    // A theme whose terminal palette is missing `selection` must clear the
    // inline value (fall back to the :root default) instead of leaving the
    // previous theme's colour stuck on the variable.
    const stripped = {
      ...base,
      tokens: {
        ...base.tokens,
        terminal: { ...base.tokens.terminal, selection: '' },
      },
    };
    applyResolvedTheme(stripped);
    expect(document.documentElement.style.getPropertyValue('--terminal-selection')).toBe('');
  });
});
