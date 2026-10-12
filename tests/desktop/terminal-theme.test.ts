import { describe, expect, test } from 'bun:test'
import { DESKTOP_TERMINAL_THEME } from '../../src/desktop/renderer/terminal-theme.ts'

describe('desktop terminal ANSI theme', () => {
  test('defines readable dark canvas and normal and bright ANSI colors', () => {
    expect(DESKTOP_TERMINAL_THEME).toMatchObject({
      background: '#171717',
      foreground: '#dedbd4',
      green: '#35c977',
      yellow: '#d2b83f',
      blue: '#168fe8',
      brightGreen: '#62e18e',
      brightYellow: '#f0d15b',
      brightBlue: '#46b3ff',
    })
    expect(Object.keys(DESKTOP_TERMINAL_THEME)).toEqual(expect.arrayContaining([
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    ]))
  })
})
