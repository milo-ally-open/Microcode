import { Box, Container, Text } from '@earendil-works/pi-tui'
import { theme } from '../../tui/theme.ts'
import { numberDiffLines, renderChangeSummary, renderTerminalDiffLine } from '../../utils/diffUtils.ts'
import {
  countContentLines,
  formatBytes,
  formatCompletedStatus,
  formatRunningStatus,
  formatToolLabel,
  getProgressFrame,
} from '../../tui/toolPresentation.ts'
import { ToolPreviewController } from '../previewController.ts'

interface ToolResult {
  content: Array<{ type: string; text?: string }>
  isError: boolean
}

interface FileWriteDetails {
  path?: string
  bytesWritten?: number
  additions?: number
  removals?: number
  isNewFile?: boolean
  preview?: string
  diff?: string[]
  diffTruncated?: boolean
  previewNotice?: string
  phase?: 'preparing' | 'approval' | 'writing' | 'complete'
  warning?: string
  written?: boolean
}

const MAX_PREVIEW_LINES = 2_000
const MAX_PREVIEW_LINE_CHARS = 2_000

function takeContentLines(content: string, limit: number): string[] {
  const lines: string[] = []
  let start = 0

  while (lines.length < limit) {
    const newline = content.indexOf('\n', start)
    if (newline < 0) {
      if (start < content.length) lines.push(content.slice(start))
      break
    }
    lines.push(content.slice(start, newline))
    start = newline + 1
    if (start === content.length) break
  }

  return lines.map((line) => line.length > MAX_PREVIEW_LINE_CHARS
    ? `${line.slice(0, MAX_PREVIEW_LINE_CHARS)}… [line truncated]`
    : line)
}

export class FileWriteToolUI extends Container {
  private args: any
  private preview = new ToolPreviewController()
  private executionStarted = false
  private elapsedMs = 0
  private result?: ToolResult
  private details?: FileWriteDetails
  private contentBox: Box
  private cachedPreviewContent?: string
  private cachedPreviewLineCount = 0

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

  toggleExpanded(): void {
    this.preview.toggle()
    this.rebuild()
  }

  hasToggleButton(): boolean {
    const isApprovalPreview = this.details?.phase === 'approval'
    if (!isApprovalPreview && (!this.result || this.executionStarted)) return false
    if (this.result && !this.details) return false
    if (this.details?.written === false && this.details.warning) return false
    const content = this.details?.preview ?? this.args?.content
    const previewLineCount = Array.isArray(this.details?.diff) && !this.details.diffTruncated
      ? this.details.diff.length
      : typeof content === 'string'
        ? this.getPreviewLineCount(content)
        : 0
    return previewLineCount > 0
  }

  getInteractionTargets(renderedLines: readonly string[]) {
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

  updateDetails(details: FileWriteDetails): void {
    this.details = details
    this.rebuild()
  }

  private rebuild(): void {
    const icon = this.result && !this.executionStarted
      ? this.result.isError || this.details?.written === false
        ? theme.fg('error', '✗')
        : theme.fg('success', '✓')
      : this.executionStarted
        ? theme.fg('warning', getProgressFrame(this.elapsedMs))
        : theme.dim('○')

    const filePath = this.details?.path || this.args?.file_path || ''
    const shortPath = filePath.split('/').slice(-2).join('/')
    const header = `${formatToolLabel(icon, 'write')}${theme.fg('accent', shortPath)}`

    this.contentBox.clear()

    if (this.details?.written === false && this.details.warning) {
      this.contentBox.addChild(
        new Text(
          `${header} ${theme.fg('warning', 'not written')}\n  ${theme.fg('muted', this.details.warning)}`,
        ),
      )
      return
    }

    // 审批前展示待写内容供用户检查；参数流入和实际写入期间只显示行数，避免刷屏。
    if (this.details?.phase === 'approval') {
      const content = this.details.preview ?? this.args?.content ?? ''
      const additions = this.details.additions ?? countContentLines(content)
      const bytes = this.details.bytesWritten ?? Buffer.byteLength(content, 'utf8')
      const summary = renderChangeSummary(additions, 0) || theme.dim('0 added lines')
      const lines = [
        `${header} ${theme.dim('awaiting approval')}${this.previewToggle()}`,
        `  ${summary} ${theme.dim(`· ${formatBytes(bytes)}`)}`,
      ]
      this.appendDiffPreview(lines, content)
      this.contentBox.addChild(new Text(lines.join('\n')))
      return
    }

    if (!this.result || this.executionStarted) {
      const additions = this.details?.additions
        ?? (typeof this.args?.content === 'string' ? countContentLines(this.args.content) : 0)
      const status = this.details?.phase === 'preparing'
        ? 'preparing'
        : this.details?.phase === 'writing'
          ? 'writing'
          : formatRunningStatus(this.elapsedMs)
      const summary = renderChangeSummary(additions, 0) || theme.dim('0 added lines')
      this.contentBox.addChild(new Text(
        `${header} ${theme.dim(status)}\n  ${summary}`,
      ))
      return
    }

    if (this.details && !this.details.isNewFile) {
      const additions = this.details.additions ?? 0
      const removals = this.details.removals ?? 0
      const summary = renderChangeSummary(additions, removals)
      const bytes = this.details?.bytesWritten
      const byteInfo = bytes === undefined ? '' : ` · ${formatBytes(bytes)}`
      const lines: string[] = [
        `${header} ${theme.dim(this.executionStarted ? 'writing' : formatCompletedStatus(this.elapsedMs))}${this.previewToggle()}`,
        `  ${summary || theme.dim('no changes')}${theme.dim(byteInfo)}`,
      ]
      this.appendDiffPreview(lines, this.details.preview ?? this.args?.content ?? '')
      this.contentBox.addChild(new Text(lines.join('\n')))
    } else if (this.details?.isNewFile) {
      // New file — show syntax preview
      const content = this.details.preview ?? this.args?.content ?? ''
      const lineCount = this.details.additions ?? countContentLines(content)
      const bytes = this.details.bytesWritten ?? Buffer.byteLength(content, 'utf8')
      const summary = renderChangeSummary(lineCount, 0)
      const lines: string[] = [
        `${header} ${theme.dim(this.executionStarted ? 'writing' : formatCompletedStatus(this.elapsedMs))}${this.previewToggle()}`,
        `  ${summary} ${theme.dim(`· ${formatBytes(bytes)} · new file`)}`,
      ]

      this.appendDiffPreview(lines, content)
      this.contentBox.addChild(new Text(lines.join('\n')))
    } else {
      // Fallback
      const output = this.getOutputPreview()
      this.contentBox.addChild(new Text(`${header} ${theme.dim(formatCompletedStatus(this.elapsedMs))}\n  ${theme.fg('muted', output || 'completed with no output')}`))
    }
  }

  private appendDiffPreview(lines: string[], content: string): void {
    const hasDiff = Array.isArray(this.details?.diff) && !this.details.diffTruncated
    const diff = hasDiff ? this.details?.diff ?? [] : undefined
    const totalLines = diff?.length ?? this.getPreviewLineCount(content)
    const requestedRows = this.preview.visibleRows(totalLines)
    const visibleRows = Math.min(requestedRows, MAX_PREVIEW_LINES)

    // 折叠状态不拆分完整文件；展开也限制行数和单行长度，避免大文件拖住 TUI。
    const visibleDiffLines = diff
      ? diff.slice(0, visibleRows)
      : takeContentLines(content, visibleRows).map((line) => `+${line}`)
    if (visibleDiffLines.length > 0) {
      lines.push(...numberDiffLines(visibleDiffLines).map(({ line, gutter }) => `  ${theme.dim(gutter)}${renderTerminalDiffLine(line)}`))
    }
    if (this.details?.previewNotice) {
      lines.push(`  ${theme.fg('warning', this.details.previewNotice)}`)
    } else if (this.details?.diffTruncated) {
      lines.push(`  ${theme.fg('warning', 'Diff unavailable for files over 1 MB; proposed content shown as additions')}`)
      if (totalLines > visibleRows) {
        lines.push(`  ${theme.dim(`Preview limited to ${visibleRows} of ${totalLines} lines`)}`)
      }
    } else if (totalLines > visibleRows) {
      lines.push(`  ${theme.dim(`Preview limited to ${visibleRows} of ${totalLines} lines`)}`)
    } else if (totalLines === 0) {
      lines.push(`  ${theme.dim('No line changes')}`)
    }
  }

  private previewToggle(): string {
    return this.hasToggleButton()
      ? `  ${theme.fg('accent', this.preview.toggleLabel())}`
      : ''
  }

  private getPreviewLineCount(content: string): number {
    if (this.cachedPreviewContent !== content) {
      this.cachedPreviewContent = content
      this.cachedPreviewLineCount = countContentLines(content)
    }
    return this.cachedPreviewLineCount
  }

  private getOutputPreview(): string {
    if (!this.result?.content) return ''
    return this.result.content
      .filter((c) => c.type === 'text')
      .map((c) => (c.text ?? '').slice(0, 200).replace(/\n/g, ' '))
      .join(' ')
  }
}
