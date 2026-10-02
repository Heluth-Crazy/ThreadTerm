import type { ITheme } from '@xterm/xterm';

/** Terminal colors are independent of the application's accent color. */
export function terminalTheme(theme: 'light' | 'dark'): ITheme {
  if (theme === 'dark') return { background: '#0a0c0e', foreground: '#f0f6fc', cursor: '#b3baf0' };
  return {
    background: '#ffffff', foreground: '#202020', cursor: '#202020', cursorAccent: '#ffffff',
    selectionBackground: '#e0e0e0', selectionInactiveBackground: '#ededed', selectionForeground: '#202020',
    scrollbarSliderBackground: '#20202026', scrollbarSliderHoverBackground: '#20202040', scrollbarSliderActiveBackground: '#20202059',
    // When a TUI uses ANSI 0 for an input/menu surface, keep that surface light;
    // xterm's minimumContrastRatio also makes ANSI-0 foreground text readable.
    black: '#f2f2f2', red: '#a33a3a', green: '#35633e', yellow: '#806020',
    blue: '#385f87', magenta: '#765078', cyan: '#444444', white: '#666666',
    brightBlack: '#666666', brightRed: '#a33a3a', brightGreen: '#35633e', brightYellow: '#806020',
    brightBlue: '#385f87', brightMagenta: '#765078', brightCyan: '#404040', brightWhite: '#404040',
  };
}
