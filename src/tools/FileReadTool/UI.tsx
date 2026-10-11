import { Box, Container, Text } from '@earendil-works/pi-tui'
import { theme } from '../../tui/theme.ts'
import { formatCompletedStatus, formatRunningStatus, formatToolLabel, getProgressFrame } from '../../tui/toolPresentation.ts'
import { ToolPreviewController } from '../previewController.ts'


interface ToolResult {
  content: Array<{ type: string; text?: string }>
  isError: boolean
}

interface FileReadDetails {
  path?: string
  totalLines?: number
  returnedLines?: number
  truncated?: boolean
  previewLines?: string[]
  previewStartLine?: number
  warning?: string
  continuation?: string
}

export class FileReadToolUI extends Container {
  private args: any
  private executionStarted = false
  private preview = new ToolPreviewController()
  private elapsedMs = 0
  private result?: ToolResult
  private details?: FileReadDetails
  private contentBox: Box

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
    return Boolean(this.result && this.preview.hasToggle(this.getOutputLines().length))
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

  updateDetails(details: FileReadDetails): void {
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

    const filePath = this.details?.path || this.args?.file_path || ''
    const shortPath = filePath.split('/').slice(-2).join('/')
    const header = `${formatToolLabel(icon, 'read')}${theme.fg('accent', shortPath)}`

    this.contentBox.clear()

    if (!this.result) {
      this.contentBox.addChild(new Text(`${header} ${theme.dim(formatRunningStatus(this.elapsedMs))}`))
      return
    }

    const totalLines = this.details?.totalLines
    const returnedLines = this.details?.returnedLines
    const truncated = this.details?.truncated

    if (totalLines !== undefined && returnedLines !== undefined) {
      const lineInfo = truncated
        ? `${returnedLines}/${totalLines} lines ${theme.dim('(truncated)')}`
        : `${returnedLines} lines`
      const summary = theme.fg('muted', lineInfo)
      const toggle = this.hasToggleButton()
        ? `  ${theme.fg('accent', this.preview.toggleLabel())}`
        : ''
      this.contentBox.addChild(new Text(`${header}  ${summary} ${theme.dim(`· ${formatCompletedStatus(this.elapsedMs)}`)}${toggle}`))
    } else {
      const lineCount = this.getOutputLines().length
      const lineInfo = lineCount === 1 ? '1 line' : `${lineCount} lines`
      const toggle = this.hasToggleButton()
        ? `  ${theme.fg('accent', this.preview.toggleLabel())}`
        : ''
      this.contentBox.addChild(new Text(
        `${header} ${theme.dim(formatCompletedStatus(this.elapsedMs))} ${theme.fg('muted', `· ${lineInfo}`)}${toggle}`,
      ))
    }

    const lines = this.getOutputLines()
    const visibleLines = lines.slice(0, this.preview.visibleRows(lines.length))
    if (lines.length > visibleLines.length) {
      if (this.preview.defaultVisibleRows > 0) visibleLines.push(theme.dim(`… ${lines.length - visibleLines.length} more lines`))
    }
    if (visibleLines.length > 0) {
      this.contentBox.addChild(new Text(visibleLines.join('\n')))
    }
  }

  private getOutputLines(): string[] {
    if (!this.result) return []
    if (Array.isArray(this.details?.previewLines)) {
      const rawLines = this.details.previewLines
      const startLine = typeof this.details.previewStartLine === 'number'
        ? this.details.previewStartLine
        : 1
      const maxLineNum = startLine + rawLines.length - 1
      const padding = String(Math.max(startLine, maxLineNum)).length
      const numbered = rawLines.map((line, index) =>
        `${String(startLine + index).padStart(padding, ' ')}\t${line}`,
      )
      return [
        ...(this.details.warning ? [this.details.warning] : []),
        ...numbered,
        ...(this.details.continuation ? [this.details.continuation] : []),
      ]
    }
    const output = this.result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('\n')
    const lines = output.split('\n')
    if (output.endsWith('\n')) lines.pop()
    return output ? lines : []
  }
}
