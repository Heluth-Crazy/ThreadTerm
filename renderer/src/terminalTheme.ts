import type { ITheme } from '@xterm/xterm';
import { customPrimaryForeground, type ResolvedTheme, type ThemeTokens } from './themes';

/** Terminal colours are independent of the application's accent colour. Their background follows the stock Mac
 * surface token, while custom themes provide their own background. */
export function terminalTheme(theme: 'light' | 'dark', customTokens?: ThemeTokens): ITheme {
  if (customTokens) return { ...terminalTheme(theme), background: customTokens.background, foreground: customTokens.text, cursor: customTokens.accent, cursorAccent: customPrimaryForeground(customTokens), selectionBackground: customTokens.accent, selectionInactiveBackground: customTokens.accent, selectionForeground: customPrimaryForeground(customTokens) };
  if (theme === 'dark') return { background: '#1e1e1e', foreground: '#ececec', cursor: '#0a84ff', cursorAccent: '#ffffff' };
  return {
    background: '#ffffff', foreground: '#1d1d1f', cursor: '#007aff', cursorAccent: '#ffffff',
    selectionBackground: '#007aff33', selectionInactiveBackground: '#007aff1f', selectionForeground: '#1d1d1f',
    scrollbarSliderBackground: '#1d1d1f26', scrollbarSliderHoverBackground: '#1d1d1f40', scrollbarSliderActiveBackground: '#1d1d1f59',
    // When a TUI uses ANSI 0 for an input/menu surface, keep that surface light;
    // xterm's minimumContrastRatio also makes ANSI-0 foreground text readable.
    black: '#f5f5f7', red: '#c41a16', green: '#1f8a3b', yellow: '#9a6200',
    blue: '#007aff', magenta: '#9b2393', cyan: '#0b4f79', white: '#6e6e73',
    brightBlack: '#a1a1a6', brightRed: '#ff3b30', brightGreen: '#34c759', brightYellow: '#ff9500',
    brightBlue: '#0a84ff', brightMagenta: '#c41a16', brightCyan: '#5d6c79', brightWhite: '#1d1d1f',
  };
}

/** xterm theme for a resolved palette: the terminal sits on the editor role and uses the preset's 16 ANSI colours. */
export function xtermThemeFor(resolved: ResolvedTheme): ITheme {
  const { colors } = resolved;
  const [black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = resolved.ansi;
  return {
    background: colors.editor,
    foreground: colors.text,
    cursor: colors.accent,
    cursorAccent: colors.accentFg,
    selectionBackground: `${colors.accent}59`,
    selectionInactiveBackground: `${colors.accent}33`,
    scrollbarSliderBackground: `${colors.text}26`,
    scrollbarSliderHoverBackground: `${colors.text}40`,
    scrollbarSliderActiveBackground: `${colors.text}59`,
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
  };
}
