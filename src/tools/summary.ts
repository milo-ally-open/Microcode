import type { ToolSummaryContext } from './registry.ts'

export function count(value: unknown, noun: string): string | undefined {
  return typeof value === 'number' ? `${value.toLocaleString()} ${noun}` : undefined
}

/** Count logical content lines without inventing a row for a final newline. */
export function countLines(value: string): number {
  if (!value) return 0
  const lines = value.split('\n').length
  return value.endsWith('\n') ? lines - 1 : lines
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function boolTag(value: unknown, label: string): string | undefined {
  return value === true ? label : undefined
}

export function statusPrefix(context: ToolSummaryContext): string {
  return context.result.isError ? 'failed · ' : ''
}

export function producedText(context: ToolSummaryContext): string {
  const { chars, lines } = context.textStats
  return `produced ${chars.toLocaleString()} chars` +
    (lines > 0 ? ` across ${lines.toLocaleString()} lines` : '')
}

export function joinSummaryParts(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(' · ')
}

export function previewList(
  values: unknown,
  limit: number,
  label: string,
): string | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined
  const rendered = values
    .slice(0, limit)
    .map((value) => typeof value === 'string' ? value : undefined)
    .filter((value): value is string => Boolean(value))
  if (rendered.length === 0) return undefined
  return `${label}: ${rendered.join(', ')}${values.length > limit ? ', ...' : ''}`
}
