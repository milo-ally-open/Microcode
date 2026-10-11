import { Box, Container, Text } from '@earendil-works/pi-tui'
import { theme } from '../../tui/theme.ts'
import { formatCompletedStatus, formatRunningStatus, formatToolLabel, getProgressFrame } from '../../tui/toolPresentation.ts'
import type { ToolResult, ToolUIComponent } from '../registry.ts'
import type { ToolInteractionTarget } from '../registry.ts'
import { ToolPreviewController } from '../previewController.ts'
import { boundedTextPreview, oneLine, textFromToolResult } from '../toolPreview.ts'

interface WebSearchDetails {
  query?: string
  results?: Array<{ title: string; url: string; snippet?: string }>
  durationMs?: number
}

const QUERY_PREVIEW_LEN = 72

function shorten(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}...` : value
}

export class WebSearchToolUI extends Container implements ToolUIComponent {
  private args: Record<string, unknown>
  private readonly preview = new ToolPreviewController()
  private executionStarted = false
  private elapsedMs = 0
  private result?: ToolResult
  private details?: WebSearchDetails
  private contentBox: Box

  constructor(_toolCallId: string, args: Record<string, unknown>) {
    super()
    this.args = args
    this.contentBox = new Box(0, 0)
    this.addChild(this.contentBox)
    this.rebuild()
  }

  setExpanded(expanded: boolean): void {
    this.preview.setExpanded(expanded)
    this.rebuild()
  }

  hasToggleButton(): boolean {
    return this.previewRows().length > 0
  }

  toggleExpanded(): void {
    this.preview.toggle()
    this.rebuild()
  }

  getInteractionTargets(renderedLines: readonly string[]): ToolInteractionTarget[] {
    return this.hasToggleButton()
      ? this.preview.interactionTarget(renderedLines, () => this.toggleExpanded())
      : []
  }

  markExecutionStarted(): void {
    this.executionStarted = true
    this.rebuild()
  }

  updateArgs(args: Record<string, unknown>): void {
    this.args = args
    this.rebuild()
  }

  updateElapsed(elapsedMs: number): void {
    this.elapsedMs = elapsedMs
    this.rebuild()
  }

  updateResult(result: ToolResult, isPartial = false): void {
    this.result = result
    if (!isPartial) {
      this.executionStarted = false
    }
    this.rebuild()
  }

  updateDetails(details: Record<string, unknown>): void {
    this.details = details as WebSearchDetails
    this.rebuild()
  }

  private rebuild(): void {
    const icon = this.result && !this.executionStarted
      ? this.result.isError
        ? theme.fg('error', '✗')
        : theme.fg('success', '✓')
      : this.executionStarted
        ? theme.fg('warning', getProgressFrame(this.elapsedMs))
        : theme.dim('○')

    const query = typeof this.args.query === 'string'
      ? this.args.query
      : this.details?.query ?? ''
    const queryPreview = shorten(query || '...', QUERY_PREVIEW_LEN)
    const header = `${formatToolLabel(icon, 'WebSearch')}${theme.fg('accent', queryPreview)}`

    this.contentBox.clear()

    if (!this.result) {
      this.contentBox.addChild(new Text(`${header} ${theme.dim(formatRunningStatus(this.elapsedMs, 'searching'))}`))
      return
    }

    if (this.result.isError) {
      const summary = oneLine(textFromToolResult(this.result) || 'Search failed', 120)
      const toggle = this.hasToggleButton() ? `  ${theme.fg('accent', this.preview.toggleLabel())}` : ''
      const lines = [`${header}  ${theme.fg('error', summary)}${toggle}`]
      if (this.preview.isExpanded()) lines.push(...this.previewRows())
      this.contentBox.addChild(new Text(lines.join('\n')))
      return
    }

    const resultCount = this.details?.results?.length
    const resultInfo = resultCount === undefined
      ? 'completed'
      : `${resultCount} result${resultCount === 1 ? '' : 's'}`
    const status = formatCompletedStatus(this.elapsedMs)
    const toggle = this.hasToggleButton() ? `  ${theme.fg('accent', this.preview.toggleLabel())}` : ''
    const lines = [`${header}  ${theme.fg('muted', resultInfo)} ${theme.dim(`· ${status}`)}${toggle}`]
    if (this.preview.isExpanded()) lines.push(...this.previewRows())
    this.contentBox.addChild(new Text(lines.join('\n')))
  }

  private previewRows(): string[] {
    if (this.details?.results?.length) {
      const text = this.details.results.map((result, index) => [
        `${index + 1}. ${result.title}`,
        `   ${result.url}`,
        result.snippet ? `   ${result.snippet}` : '',
      ].filter(Boolean).join('\n')).join('\n\n')
      return boundedTextPreview(text).rows
    }
    const output = textFromToolResult(this.result)
    return output.trim() ? boundedTextPreview(output).rows : []
  }
}
