import { Box, Container, Text } from '@earendil-works/pi-tui'
import chalk from 'chalk'
import { theme } from '../../tui/theme.ts'
import { formatCompletedStatus, formatRunningStatus, formatToolLabel, getProgressFrame } from '../../tui/toolPresentation.ts'
import { ToolPreviewController } from '../previewController.ts'

import type { ToolUIComponent, ToolResult } from '../registry.ts'

interface BashDetails {
  stdout: string
  stderr: string
  output?: string
  displayOutput?: string
  displayTruncated?: boolean
  exitCode: number | null
}

const COMMAND_PREVIEW_LEN = 80

export class BashToolUI extends Container implements ToolUIComponent {
  private args: any
  private preview = new ToolPreviewController()
  private executionStarted = false
  private elapsedMs = 0
  private result?: ToolResult
  private details?: BashDetails
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
    if (!this.result) return false
    const output = this.getOutput()
    return output.length > 0
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

  updateDetails(details: Record<string, unknown>): void {
    this.details = {
      stdout: typeof details.stdout === 'string' ? details.stdout : '',
      stderr: typeof details.stderr === 'string' ? details.stderr : '',
      output: typeof details.output === 'string' ? details.output : undefined,
      displayOutput: typeof details.displayOutput === 'string' ? details.displayOutput : undefined,
      displayTruncated: details.displayTruncated === true,
      exitCode: typeof details.exitCode === 'number' || details.exitCode === null
        ? details.exitCode
        : null,
    }
    this.rebuild()
  }

  private rebuild(): void {
    const icon = this.result && !this.executionStarted
      ? this.result.isError
        ? theme.fg('error', '✗')   // ✗
        : theme.fg('success', '✓')  // ✓
      : this.executionStarted
        ? theme.fg('warning', getProgressFrame(this.elapsedMs))
        : theme.dim('○')            // ○

    const cmd = this.args?.command ?? ''
    const shortCmd = cmd.length > COMMAND_PREVIEW_LEN
      ? cmd.slice(0, COMMAND_PREVIEW_LEN) + '...'
      : cmd
    const description = this.args?.description
    const header = description
      ? `${formatToolLabel(icon, 'bash')}${theme.dim(description)}`
      : `${formatToolLabel(icon, 'bash')}${theme.fg('muted', '$')} ${theme.fg('text', shortCmd)}`

    this.contentBox.clear()

    if (!this.result) {
      this.contentBox.addChild(new Text(`${header} ${theme.dim(formatRunningStatus(this.elapsedMs))}`))
      return
    }

    const output = this.getOutput()
    const lines = this.getOutputLines(output)

    if (lines.length === 0 || (lines.length === 1 && !lines[0])) {
      const exitLine = this.renderExitCode()
      const status = theme.dim(formatCompletedStatus(this.elapsedMs))
      this.contentBox.addChild(new Text(exitLine ? `${header} ${status}\n${exitLine}` : `${header} ${status}`))
      return
    }

    const hasMoreOutput = lines.length > 0
    const displayLines = lines.slice(0, this.preview.visibleRows(lines.length))
    const outputText = displayLines.join('\n')

    const exitLine = this.renderExitCode()
    const toggleHint = hasMoreOutput
      ? theme.fg('accent',
          this.preview.toggleLabel(),
        )
      : ''

    let content = header
    content += ` ${theme.dim(
      this.executionStarted
        ? formatRunningStatus(this.elapsedMs)
        : formatCompletedStatus(this.elapsedMs),
    )}`
    if (toggleHint) content += `  ${toggleHint}`
    if (outputText) content += `\n${outputText}`
    if (exitLine) content += `\n${exitLine}`

    this.contentBox.addChild(new Text(content))
  }

  private renderExitCode(): string {
    if (!this.details || this.executionStarted) return ''
    const { exitCode } = this.details
    if (exitCode === null || exitCode === undefined) return ''
    if (exitCode === 0) {
      return theme.dim(`exit: ${exitCode}`)
    }
    return theme.fg('error', `exit: ${exitCode}`)
  }

  private getOutput(): string {
    if (this.details) {
      const { stdout, stderr, output, displayOutput, displayTruncated } = this.details
      if (typeof displayOutput === 'string') {
        const suffix = displayTruncated ? '\n… UI preview capped at 80,000 characters' : ''
        return `${displayOutput}${suffix}`.trimEnd()
      }
      return (typeof output === 'string' ? output : `${stdout}${stderr}`).trimEnd()
    }
    if (!this.result?.content) return ''
    return this.result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
      .trimEnd()
  }

  private getOutputLines(output = this.getOutput()): string[] {
    return output ? output.split('\n') : []
  }
}
