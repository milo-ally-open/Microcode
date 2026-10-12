import type { ITheme } from '@xterm/xterm'

/** ANSI palette tuned for readable shell prompts and command output on the desktop canvas. */
export const DESKTOP_TERMINAL_THEME: ITheme = Object.freeze({
  background: '#171717',
  foreground: '#dedbd4',
  cursor: '#f1eee8',
  cursorAccent: '#171717',
  selectionBackground: '#3c5268',
  black: '#252525',
  red: '#d76565',
  green: '#35c977',
  yellow: '#d2b83f',
  blue: '#168fe8',
  magenta: '#bd79d1',
  cyan: '#40b8d4',
  white: '#d3cec5',
  brightBlack: '#777777',
  brightRed: '#f06d66',
  brightGreen: '#62e18e',
  brightYellow: '#f0d15b',
  brightBlue: '#46b3ff',
  brightMagenta: '#d597e8',
  brightCyan: '#75dcf2',
  brightWhite: '#fffaf0',
})
