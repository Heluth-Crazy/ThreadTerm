import type { ITheme } from '@xterm/xterm';

/** Terminal colors are independent of the application's accent color. The background equals the card it sits in
 * (`--term-bg`/`--surface` of the warm palette in styles.css); keep the two in step. */
export function terminalTheme(theme: 'light' | 'dark'): ITheme {
  if (theme === 'dark') return { background: '#2c2c2a', foreground: '#ecebe5', cursor: '#b3baf0', cursorAccent: '#2c2c2a' };
  return {
    background: '#fefdfb', foreground: '#23221f', cursor: '#23221f', cursorAccent: '#fefdfb',
    selectionBackground: '#e4e1d8', selectionInactiveBackground: '#eeebe4', selectionForeground: '#23221f',
    scrollbarSliderBackground: '#23221f26', scrollbarSliderHoverBackground: '#23221f40', scrollbarSliderActiveBackground: '#23221f59',
    // When a TUI uses ANSI 0 for an input/menu surface, keep that surface light;
    // xterm's minimumContrastRatio also makes ANSI-0 foreground text readable.
    black: '#f2f0ea', red: '#a33a3a', green: '#35633e', yellow: '#806020',
    blue: '#385f87', magenta: '#765078', cyan: '#444444', white: '#666666',
    brightBlack: '#666666', brightRed: '#a33a3a', brightGreen: '#35633e', brightYellow: '#806020',
    brightBlue: '#385f87', brightMagenta: '#765078', brightCyan: '#404040', brightWhite: '#404040',
  };
}
