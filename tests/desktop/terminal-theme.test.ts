import { describe, expect, test } from 'bun:test'
import { DESKTOP_TERMINAL_FONT_FAMILY, DESKTOP_TERMINAL_THEME } from '../../src/desktop/renderer/terminal-theme.ts'

describe('desktop terminal ANSI theme', () => {
  test('uses a deterministic Windows monospace font with safe fallbacks', () => {
    expect(DESKTOP_TERMINAL_FONT_FAMILY).toBe('Consolas, "Courier New", monospace')
  })

  test('defines readable dark canvas and normal and bright ANSI colors', () => {
    expect(DESKTOP_TERMINAL_THEME).toMatchObject({
      background: '#171717',
      foreground: '#dedede',
      green: '#a0a0a0',
      yellow: '#b8b8b8',
      blue: '#777777',
      brightGreen: '#b0b0b0',
      brightYellow: '#cecece',
      brightBlue: '#929292',
    })
    expect(Object.keys(DESKTOP_TERMINAL_THEME)).toEqual(expect.arrayContaining([
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    ]))
  })

  test('uses neutral grayscale values across the terminal palette', () => {
    for (const color of Object.values(DESKTOP_TERMINAL_THEME)) {
      expect(color).toMatch(/^#([\da-f]{2})\1\1$/i)
    }
  })
})
