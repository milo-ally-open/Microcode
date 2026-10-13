import { describe, expect, test } from 'bun:test'
import { normalizeTerminalDimensions } from '../../src/desktop/renderer/terminal-dimensions.ts'

describe('desktop terminal dimensions', () => {
  test('keeps small but measurable panes valid for the PTY IPC bounds', () => {
    expect(normalizeTerminalDimensions(1, 1)).toEqual({ cols: 1, rows: 1 })
    expect(normalizeTerminalDimensions(0, 0)).toEqual({ cols: 1, rows: 1 })
  })

  test('normalizes fractional and oversized dimensions to the supported limits', () => {
    expect(normalizeTerminalDimensions(120.9, 24.8)).toEqual({ cols: 120, rows: 24 })
    expect(normalizeTerminalDimensions(900, 500)).toEqual({ cols: 300, rows: 100 })
    expect(normalizeTerminalDimensions(Number.POSITIVE_INFINITY, Number.NaN)).toEqual({ cols: 1, rows: 1 })
  })
})
