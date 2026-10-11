import { Box, Container, Text } from '@earendil-works/pi-tui'
import { theme } from '../../tui/theme.ts'
import { formatCompletedStatus, formatRunningStatus, formatToolLabel, getProgressFrame } from '../../tui/toolPresentation.ts'
import type { TaskList } from '../../tasks/TaskSystem.ts'
import type { ToolResult, ToolUIComponent } from '../registry.ts'
import { ToolPreviewController } from '../previewController.ts'
import type { ToolInteractionTarget } from '../registry.ts'
import { boundedTextPreview, oneLine, textFromToolResult } from '../toolPreview.ts'

interface TaskToolDetails {
  action: 'write' | 'claim' | 'mark' | 'mark_batch'
  list: TaskList
}

interface DisplayTask {
  content: string
  completed: boolean
}

export class TaskToolUI extends Container implements ToolUIComponent {
  private args: any
  private result?: ToolResult
  private details?: TaskToolDetails
  private executionStarted = false
  private elapsedMs = 0
  private readonly contentBox: Box
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
    if (!isPartial) this.executionStarted = false
    this.rebuild()
  }

  updateDetails(details: Record<string, unknown>): void {
    this.details = details as unknown as TaskToolDetails
    this.rebuild()
  }

  private rebuild(): void {
    this.contentBox.clear()
    const icon = this.result && !this.executionStarted
      ? this.result.isError ? theme.fg('error', '✗') : theme.fg('success', '✓')
      : this.executionStarted ? theme.fg('warning', getProgressFrame(this.elapsedMs)) : theme.dim('○')
    const status = this.result && !this.executionStarted
      ? formatCompletedStatus(this.elapsedMs)
      : formatRunningStatus(this.elapsedMs)

    if (this.result?.isError) {
      const error = textFromToolResult(this.result) || 'The task operation failed.'
      const summary = error.includes('Validation failed for tool')
        ? 'The task request was incomplete or used an unsupported field.'
        : oneLine(error, 120)
      const toggle = this.hasToggleButton() ? `  ${theme.fg('accent', this.preview.toggleLabel())}` : ''
      const lines = [`${formatToolLabel(icon, 'Tasks')}${theme.fg('error', summary)} ${theme.dim(`· ${status}`)}${toggle}`]
      if (this.preview.isExpanded()) lines.push(...this.previewRows())
      this.contentBox.addChild(new Text(lines.join('\n')))
      return
    }


    const action = this.details?.action ?? this.args?.action
    const list = this.details?.list

    if ((action === 'mark' || action === 'mark_batch') && !list) {
      const taskId = typeof this.args?.task_id === 'string'
        ? this.args.task_id
        : action === 'mark_batch' && Array.isArray(this.args?.tasks)
          ? `${this.args.tasks.length} tasks`
          : 'task'
      const state = this.executionStarted ? 'Updating' : 'Updated'
      const toggle = this.hasToggleButton() ? `  ${theme.fg('accent', this.preview.toggleLabel())}` : ''
      const lines = [`${formatToolLabel(icon, 'Tasks')}${theme.dim(`${state} ${taskId}… · ${status}`)}${toggle}`]
      if (this.preview.isExpanded()) lines.push(...this.previewRows())
      this.contentBox.addChild(new Text(lines.join('\n')))
      return
    }

    const title = list?.title ?? this.args?.title ?? 'Task list'
    const tasks = list?.tasks ?? this.tasksFromArgs()
    const completedCount = tasks.filter((task) => task.completed).length
    const progress = action === 'claim' && tasks.length === 0
      ? theme.fg('success', 'All tasks are complete')
      : tasks.length > 0
      ? theme.dim(`${completedCount}/${tasks.length} complete`)
      : theme.dim('No tasks')
    const heading = action === 'claim' ? 'Next tasks' : 'Tasks'
    const toggle = this.hasToggleButton() ? `  ${theme.fg('accent', this.preview.toggleLabel())}` : ''
    const lines = [`${formatToolLabel(icon, heading)}${theme.fg('accent', title)}  ${progress} ${theme.dim(`· ${status}`)}${toggle}`]
    if (this.preview.isExpanded()) lines.push(...this.previewRows())

    this.contentBox.addChild(new Text(lines.join('\n')))
  }

  private previewRows(): string[] {
    const list = this.details?.list
    if (list) {
      const rows = list.tasks.map((task) => {
        const marker = task.completed ? '✓' : '○'
        return `  ${marker} ${task.content}`
      })
      return rows.length ? boundedTextPreview(rows.join('\n')).rows : []
    }
    const resultText = textFromToolResult(this.result)
    return resultText.trim() ? boundedTextPreview(resultText).rows : []
  }

  private tasksFromArgs(): DisplayTask[] {
    if (this.args?.action === 'write' && Array.isArray(this.args.tasks)) {
      return this.args.tasks.map((task: unknown) => {
        if (typeof task === 'string') {
          return { content: task, completed: false }
        }
        if (task && typeof task === 'object') {
          const value = task as Record<string, unknown>
          return {
            content: typeof value.content === 'string'
              ? value.content
              : '(task content pending)',
            completed: value.status === 'completed',
          }
        }
        return { content: String(task), completed: false }
      })
    }
    return []
  }
}
