import { Box, Container, Text } from '@earendil-works/pi-tui'
import { theme } from '../../tui/theme.ts'
import { formatCompletedStatus, formatRunningStatus, formatToolLabel, getProgressFrame } from '../../tui/toolPresentation.ts'

import type { ToolUIComponent, ToolResult } from '../registry.ts'
import type { ToolInteractionTarget } from '../registry.ts'
import { ToolPreviewController } from '../previewController.ts'
import { boundedTextPreview } from '../toolPreview.ts'

interface AskUserQuestionDetails {
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect?: boolean
  }>
  answers: Record<string, string>
}

export class AskUserQuestionToolUI extends Container implements ToolUIComponent {
  private args: any
  private executionStarted = false
  private result?: ToolResult
  private details?: AskUserQuestionDetails
  private elapsedMs = 0
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

  updateDetails(details: Record<string, unknown>): void {
    this.details = details as unknown as AskUserQuestionDetails
    this.rebuild()
  }

  private rebuild(): void {
    const icon = this.result && !this.executionStarted
      ? this.result.isError ? theme.fg('error', '✗') : theme.fg('success', '✓')
      : this.executionStarted ? theme.fg('warning', getProgressFrame(this.elapsedMs)) : theme.dim('○')

    this.contentBox.clear()

    const questions = this.details?.questions ?? this.args?.questions ?? []
    const answers = this.details?.answers ?? {}

    if (questions.length === 0) {
      this.contentBox.addChild(
        new Text(`${formatToolLabel(icon, 'Ask')}${theme.dim('(no questions)')}`),
      )
      return
    }

    const answered = Object.keys(answers).length
    const count = `${questions.length} question${questions.length > 1 ? 's' : ''}, ${answered} answered`
    const status = this.result && !this.executionStarted
      ? formatCompletedStatus(this.elapsedMs)
      : formatRunningStatus(this.elapsedMs)
    const header = `${formatToolLabel(icon, 'Ask')}${theme.dim(`${count} · ${status}`)}`
    const toggle = this.hasToggleButton() ? `  ${theme.fg('accent', this.preview.toggleLabel())}` : ''
    const lines = [`${header}${toggle}`]
    if (this.preview.isExpanded()) lines.push(...this.previewRows())
    this.contentBox.addChild(new Text(lines.join('\n')))
  }

  private previewRows(): string[] {
    const questions = this.details?.questions ?? this.args?.questions ?? []
    const answers = this.details?.answers ?? this.args?.answers ?? {}
    const rows: string[] = []
    for (const question of questions) {
      const answer = answers[question.question]
      rows.push(`${question.header}: ${question.question}`)
      rows.push(`  → ${answer || '(unanswered)'}`)
    }
    return rows.length ? boundedTextPreview(rows.join('\n')).rows : []
  }
}
