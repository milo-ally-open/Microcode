import { Box, Container, Text } from '@earendil-works/pi-tui'
import { theme } from '../../tui/theme.ts'
import { formatCompletedStatus, formatRunningStatus, formatToolLabel, getProgressFrame } from '../../tui/toolPresentation.ts'
import { ToolPreviewController } from '../previewController.ts'
import type { ToolInteractionTarget } from '../registry.ts'
import { boundedTextPreview, oneLine, textFromToolResult } from '../toolPreview.ts'

interface ToolResult {
  content: Array<{ type: string; text?: string }>
  isError: boolean
}

interface GlobDetails {
  numFiles?: number
  filenames?: string[]
  truncated?: boolean
  durationMs?: number
}

export class GlobToolUI extends Container {
  private args: any
  private executionStarted = false
  private elapsedMs = 0
  private result?: ToolResult
  private details?: GlobDetails
  private contentBox: Box
  private readonly preview = new ToolPreviewController()

  constructor(_toolCallId: string, args: any) {
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

  updateDetails(details: GlobDetails): void {
    this.details = details
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

    const pattern = this.args?.pattern || '...'
    const shortPattern = pattern.length > 40 ? pattern.slice(0, 40) + '...' : pattern

    this.contentBox.clear()

    if (!this.result) {
      this.contentBox.addChild(new Text(`${formatToolLabel(icon, 'Glob')}${theme.fg('accent', shortPattern)} ${theme.dim(formatRunningStatus(this.elapsedMs))}`))
      return
    }

    const numFiles = this.details?.numFiles
    const truncated = this.details?.truncated
    if (this.result.isError) {
      const summary = oneLine(textFromToolResult(this.result) || 'File search failed', 120)
      const toggle = this.hasToggleButton() ? `  ${theme.fg('accent', this.preview.toggleLabel())}` : ''
      const lines = [`${formatToolLabel(icon, 'Glob')}${theme.fg('accent', shortPattern)}  ${theme.fg('error', summary)}${toggle}`]
      if (this.preview.isExpanded()) lines.push(...this.previewRows())
      this.contentBox.addChild(new Text(lines.join('\n')))
      return
    }
    const fileInfo = numFiles === undefined
      ? 'completed'
      : `${numFiles} file${numFiles === 1 ? '' : 's'}${truncated ? ' (truncated)' : ''}`
    const toggle = this.hasToggleButton() ? `  ${theme.fg('accent', this.preview.toggleLabel())}` : ''
    const lines = [`${formatToolLabel(icon, 'Glob')}${theme.fg('accent', shortPattern)}  ${theme.fg('muted', fileInfo)} ${theme.dim(`· ${formatCompletedStatus(this.elapsedMs)}`)}${toggle}`]
    if (this.preview.isExpanded()) lines.push(...this.previewRows())
    this.contentBox.addChild(new Text(lines.join('\n')))
  }

  private previewRows(): string[] {
    const filenames = this.details?.filenames
    const output = filenames?.length ? filenames.join('\n') : textFromToolResult(this.result)
    return output.trim() ? boundedTextPreview(output).rows : []
  }
}
