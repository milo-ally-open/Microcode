import { diffLines, structuredPatch } from 'diff'
import chalk from 'chalk'

type ParsedDiff = ReturnType<typeof structuredPatch>
type Hunk = ParsedDiff['hunks'][number]

export interface DiffResult {
  patch: ParsedDiff
  additions: number
  removals: number
}

export interface ChangeCounts {
  additions: number
  removals: number
}

/** Render unified-diff rows with bright, high-contrast add/remove colors. */
export function renderTerminalDiffLine(line: string): string {
  if (line.startsWith('+')) return chalk.bgHex('#173b29').hex('#7ee787').bold(line)
  if (line.startsWith('-')) return chalk.bgHex('#482225').hex('#ff7b72').bold(line)
  if (line.startsWith('@@')) return chalk.hex('#79c0ff').bold(line)
  return chalk.hex('#a5adb8')(line)
}

/** Add old/new file line numbers to unified diff rows for terminal previews. */
export function numberDiffLines(lines: readonly string[]): Array<{ line: string; gutter: string }> {
  let oldLine = 0
  let newLine = 0
  const numbered = lines.map((line) => {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      return { line, oldNumber: '', newNumber: '' }
    }

    if (line.startsWith('-')) {
      return { line, oldNumber: String(oldLine++), newNumber: '' }
    }
    if (line.startsWith('+')) {
      if (newLine === 0) newLine = 1
      return { line, oldNumber: '', newNumber: String(newLine++) }
    }
    if (line.startsWith(' ')) {
      return { line, oldNumber: String(oldLine++), newNumber: String(newLine++) }
    }
    return { line, oldNumber: '', newNumber: '' }
  })

  const oldWidth = Math.max(1, ...numbered.map(({ oldNumber }) => oldNumber.length))
  const newWidth = Math.max(1, ...numbered.map(({ newNumber }) => newNumber.length))
  return numbered.map(({ line, oldNumber, newNumber }) => ({
    line,
    gutter: `${oldNumber.padStart(oldWidth)} ${newNumber.padStart(newWidth)} │ `,
  }))
}

const MAX_EXACT_DIFF_CHARS = 1_000_000

function countLines(content: string): number {
  if (content.length === 0) return 0
  let lines = 1
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lines++
  }
  return content.endsWith('\n') ? lines - 1 : lines
}

export function countLineChanges(oldContent: string, newContent: string): ChangeCounts {
  if (oldContent.length + newContent.length > MAX_EXACT_DIFF_CHARS) {
    return {
      additions: countLines(newContent),
      removals: countLines(oldContent),
    }
  }

  let additions = 0
  let removals = 0

  for (const change of diffLines(oldContent, newContent)) {
    const count = change.count ?? 0
    if (change.added) additions += count
    if (change.removed) removals += count
  }

  return { additions, removals }
}

const CONTEXT_LINES = 3

/**
 * Generate a structured diff between old and new content.
 */
export function generateDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): DiffResult {
  const patch = structuredPatch(filePath, filePath, oldContent, newContent, undefined, undefined, {
    context: CONTEXT_LINES,
  })
  const { additions, removals } = countChanges(patch)
  return { patch, additions, removals }
}

/**
 * Count added and removed lines from a parsed diff.
 */
export function countChanges(patch: ParsedDiff): ChangeCounts {
  let additions = 0
  let removals = 0
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) removals++
    }
  }
  return { additions, removals }
}

/**
 * Render diff hunks as colored terminal lines.
 * Returns an array of styled strings, one per line.
 */
export function renderHunkLines(hunk: Hunk, width: number): string[] {
  const lines: string[] = []

  // Hunk header
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
  lines.push(chalk.white(header))

  for (const line of hunk.lines) {
    const truncated = line.length > width ? line.slice(0, width - 1) + '…' : line

    if (line.startsWith('+')) {
      lines.push(chalk.hex('#b5bd68')(truncated))
    } else if (line.startsWith('-')) {
      lines.push(chalk.hex('#cc6666')(truncated))
    } else {
      // Context line (starts with ' ' or empty)
      lines.push(chalk.hex('#808080')(truncated))
    }
  }

  return lines
}

/**
 * Render a summary of changes: "Added N lines, removed M lines"
 */
export function renderChangeSummary(additions: number, removals: number): string {
  const parts: string[] = []
  if (additions > 0) parts.push(chalk.hex('#b5bd68')(`+${additions} line${additions === 1 ? '' : 's'}`))
  if (removals > 0) parts.push(chalk.hex('#cc6666')(`-${removals} line${removals === 1 ? '' : 's'}`))
  return parts.join(chalk.hex('#808080')(', '))
}

/**
 * Render a preview of the diff (first N lines from first M hunks).
 * Returns an array of styled strings.
 */
export function renderDiffPreview(
  patch: ParsedDiff,
  width: number,
  maxHunks = 2,
  maxLines = 15,
): string[] {
  const lines: string[] = []
  const hunksToShow = patch.hunks.slice(0, maxHunks)

  for (let i = 0; i < hunksToShow.length; i++) {
    if (i > 0) lines.push(chalk.hex('#666666')('  ...'))
    const hunkLines = renderHunkLines(hunksToShow[i], width)
    lines.push(...hunkLines)
  }

  if (patch.hunks.length > maxHunks) {
    const remaining = patch.hunks.length - maxHunks
    lines.push(chalk.hex('#666666')(`  ... (${remaining} more hunk${remaining === 1 ? '' : 's'})`))
  }

  return lines.slice(0, maxLines)
}

/**
 * Render full diff output from all hunks.
 */
export function renderFullDiff(patch: ParsedDiff, width: number): string[] {
  const lines: string[] = []
  for (let i = 0; i < patch.hunks.length; i++) {
    if (i > 0) lines.push(chalk.hex('#666666')('  ...'))
    lines.push(...renderHunkLines(patch.hunks[i], width))
  }
  return lines
}

/**
 * Render a syntax preview for new files (first N lines with line numbers).
 */
export function renderNewFilePreview(content: string, maxLines = 10): string[] {
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  const truncated = lines.length > maxLines
  const showLines = lines.slice(0, maxLines)
  const padding = String(showLines.length).length

  const result: string[] = []
  for (let i = 0; i < showLines.length; i++) {
    const lineNum = chalk.hex('#666666')(String(i + 1).padStart(padding, ' '))
    result.push(`${lineNum}  ${chalk.hex('#808080')(showLines[i])}`)
  }

  if (truncated) {
    const remaining = lines.length - maxLines
    result.push(chalk.hex('#666666')(`  ... +${remaining} more line${remaining === 1 ? '' : 's'}`))
  }

  return result
}
