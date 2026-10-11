import { Box, Container, Text } from '@earendil-works/pi-tui'
import { theme } from '../../tui/theme.ts'
import { formatCompletedStatus, formatRunningStatus, formatToolLabel, getProgressFrame } from '../../tui/toolPresentation.ts'
import type { ToolResult, ToolUIComponent } from '../registry.ts'
import type { ToolInteractionTarget } from '../registry.ts'
import { ToolPreviewController } from '../previewController.ts'
import { boundedTextPreview, oneLine, textFromToolResult } from '../toolPreview.ts'

interface WebFetchDetails {
  url?: string
  finalUrl?: string
  bytes?: number
  code?: number
  codeText?: string
  contentType?: string
  truncated?: boolean
  durationMs?: number
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value)
    const path = `${url.pathname}${url.search}`.replace(/\/$/, '')
    const preview = `${url.hostname}${path}`
    return preview.length > 72 ? `...${preview.slice(-69)}` : preview
  } catch {
    return value.length > 72 ? `...${value.slice(-69)}` : value
  }
}

export class WebFetchToolUI extends Container implements ToolUIComponent {
  private args: Record<string, unknown>
  private readonly preview = new ToolPreviewController()
  private executionStarted = false
  private elapsedMs = 0
  private result?: ToolResult
  private details?: WebFetchDetails
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
    this.details = details as WebFetchDetails
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

    const url = typeof this.args.url === 'string'
      ? this.args.url
      : this.details?.url ?? ''
    const header = `${formatToolLabel(icon, 'WebFetch')}${theme.fg('accent', displayUrl(url || '...'))}`

    this.contentBox.clear()

    if (!this.result) {
      this.contentBox.addChild(new Text(`${header} ${theme.dim(formatRunningStatus(this.elapsedMs, 'fetching'))}`))
      return
    }

    if (this.result.isError) {
      const summary = oneLine(textFromToolResult(this.result) || 'Fetch failed', 120)
      const toggle = this.hasToggleButton() ? `  ${theme.fg('accent', this.preview.toggleLabel())}` : ''
      const lines = [`${header}  ${theme.fg('error', summary)}${toggle}`]
      if (this.preview.isExpanded()) lines.push(...this.previewRows())
      this.contentBox.addChild(new Text(lines.join('\n')))
      return
    }

    const parts: string[] = []
    if (this.details?.code) parts.push(String(this.details.code))
    if (this.details?.bytes !== undefined) parts.push(formatBytes(this.details.bytes))
    if (this.details?.truncated) parts.push(theme.dim('truncated'))
    if (parts.length === 0) parts.push('completed')

    const toggle = this.hasToggleButton() ? `  ${theme.fg('accent', this.preview.toggleLabel())}` : ''
    const lines = [`${header}  ${theme.fg('muted', parts.join(', '))} ${theme.dim(`· ${formatCompletedStatus(this.elapsedMs)}`)}${toggle}`]
    if (this.preview.isExpanded()) lines.push(...this.previewRows())
    this.contentBox.addChild(new Text(lines.join('\n')))
  }

  private previewRows(): string[] {
    const output = textFromToolResult(this.result)
    return output.trim() ? boundedTextPreview(output).rows : []
  }
}
