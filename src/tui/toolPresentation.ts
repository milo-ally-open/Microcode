import chalk from 'chalk'

const TOOL_LABEL_COLUMN_WIDTH = 12

/** Formats the tool-name column so each tool's argument summary starts together. */
export function formatToolLabel(icon: string, label: string): string {
  const padding = ' '.repeat(Math.max(1, TOOL_LABEL_COLUMN_WIDTH - label.length))
  return `${icon} ${chalk.bold(label)}${padding}`
}

function formatDuration(elapsedMs: number): string {
  const safeElapsedMs = Math.max(0, elapsedMs)

  if (safeElapsedMs < 1_000) {
    return `${Math.round(safeElapsedMs)}ms`
  }

  if (safeElapsedMs < 10_000) {
    return `${(safeElapsedMs / 1_000).toFixed(1)}s`
  }

  if (safeElapsedMs < 60_000) {
    return `${Math.round(safeElapsedMs / 1_000)}s`
  }

  const totalSeconds = Math.round(safeElapsedMs / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

export function getProgressFrame(_elapsedMs: number): string {
  return '●'
}

export function formatRunningStatus(elapsedMs: number, action = 'running'): string {
  return `${action} · ${formatDuration(elapsedMs)}`
}

export function formatCompletedStatus(elapsedMs: number): string {
  return `completed · ${formatDuration(elapsedMs)}`
}

export function formatBytes(bytes: number): string {
  const safeBytes = Math.max(0, bytes)
  if (safeBytes < 1_024) return `${safeBytes} B`

  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = safeBytes / 1_024
  let unitIndex = 0

  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024
    unitIndex++
  }

  const precision = value < 10 ? 1 : 0
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}
export function countContentLines(content: string): number {
  if (content.length === 0) return 0

  let lineCount = 1
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) lineCount++
  }

  return content.endsWith('\n') ? lineCount - 1 : lineCount
}
