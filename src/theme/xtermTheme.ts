import type { TerminalThemeTokens } from './themeTypes';

export function toXtermTheme(tokens: TerminalThemeTokens) {
  return {
    background: tokens.background,
    foreground: tokens.foreground,
    cursor: tokens.cursor,
    cursorAccent: tokens.cursorAccent,
    selection: tokens.selection,
    selectionForeground: tokens.selectionForeground,
    black: tokens.black,
    red: tokens.red,
    green: tokens.green,
    yellow: tokens.yellow,
    blue: tokens.blue,
    magenta: tokens.magenta,
    cyan: tokens.cyan,
    white: tokens.white,
    brightBlack: tokens.brightBlack,
    brightRed: tokens.brightRed,
    brightGreen: tokens.brightGreen,
    brightYellow: tokens.brightYellow,
    brightBlue: tokens.brightBlue,
    brightMagenta: tokens.brightMagenta,
    brightCyan: tokens.brightCyan,
    brightWhite: tokens.brightWhite,
  };
}

