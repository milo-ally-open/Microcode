export interface TerminalDimensions {
  readonly cols: number
  readonly rows: number
}

/** Keep xterm and the PTY in the same safe, non-zero size range. */
export function normalizeTerminalDimensions(cols: number, rows: number): TerminalDimensions {
  const clamp = (value: number, maximum: number) => Number.isFinite(value)
    ? Math.max(1, Math.min(maximum, Math.floor(value)))
    : 1
  return Object.freeze({ cols: clamp(cols, 300), rows: clamp(rows, 100) })
}
