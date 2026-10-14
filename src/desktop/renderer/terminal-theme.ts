import type { ITheme } from '@xterm/xterm'

export const DESKTOP_TERMINAL_FONT_FAMILY = 'Consolas, "Courier New", monospace'

/** ANSI palette tuned for readable shell prompts and command output on the desktop canvas. */
export const DESKTOP_TERMINAL_THEME: ITheme = Object.freeze({
  background: '#171717',
  foreground: '#dedede',
  cursor: '#f1f1f1',
  cursorAccent: '#171717',
  selectionBackground: '#454545',
  black: '#252525',
  red: '#858585',
  green: '#a0a0a0',
  yellow: '#b8b8b8',
  blue: '#777777',
  magenta: '#999999',
  cyan: '#adadad',
  white: '#d3d3d3',
  brightBlack: '#777777',
  brightRed: '#a0a0a0',
  brightGreen: '#b0b0b0',
  brightYellow: '#cecece',
  brightBlue: '#929292',
  brightMagenta: '#b8b8b8',
  brightCyan: '#d0d0d0',
  brightWhite: '#ffffff',
})
