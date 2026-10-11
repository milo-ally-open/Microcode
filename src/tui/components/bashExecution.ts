import { Container, Loader, Spacer, Text, type TUI } from '@earendil-works/pi-tui'
import { theme } from '../theme.ts'

/**
 * Component for displaying bash command execution with streaming output.
 */
export class BashExecutionComponent extends Container {
  private static readonly MAX_OUTPUT_LINES = 200
  private outputLines: string[] = []
  private loader: Loader
  private contentContainer: Container
  private exitCode?: number
  private cancelled = false
  private completed = false

  constructor(command: string, ui: TUI, excludeFromContext = false) {
    super()

    // Use dim border for excluded-from-context commands (!! prefix)
    const colorKey = excludeFromContext ? 'dim' : 'accent'

    // Add spacer
    this.addChild(new Spacer(1))

    // Command header
    const header = new Text(theme.fg(colorKey, theme.bold(`$ ${command}`)), 1, 0)
    this.addChild(header)

    // Content container (holds dynamic content)
    this.contentContainer = new Container()
    this.addChild(this.contentContainer)

    // Loader
    this.loader = new Loader(
      ui,
      (spinner) => theme.fg(colorKey, spinner),
      (text) => theme.fg('dim', text),
      'Running... (Esc to cancel)',
    )
    this.contentContainer.addChild(this.loader)
  }

  appendOutput(chunk: string): void {
    // Normalize line endings
    const clean = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

    // Append to output lines
    const newLines = clean.split('\n')
    if (this.outputLines.length > 0 && newLines.length > 0) {
      // Append first chunk to last line (incomplete line continuation)
      this.outputLines[this.outputLines.length - 1] += newLines[0]
      this.outputLines.push(...newLines.slice(1))
    } else {
      this.outputLines.push(...newLines)
    }
    if (this.outputLines.length > BashExecutionComponent.MAX_OUTPUT_LINES) {
      this.outputLines = this.outputLines.slice(-BashExecutionComponent.MAX_OUTPUT_LINES)
    }

    this.updateDisplay()
  }

  setComplete(exitCode: number | undefined, cancelled: boolean): void {
    this.exitCode = exitCode
    this.cancelled = cancelled
    this.completed = true
    this.updateDisplay()
  }

  private updateDisplay(): void {
    this.contentContainer.clear()

    if (this.completed) {
      let statusText = ''
      if (this.cancelled) {
        statusText = theme.fg('warning', 'Cancelled')
      } else if (this.exitCode === 0) {
        statusText = theme.fg('success', `Exit code: ${this.exitCode}`)
      } else {
        statusText = theme.fg('error', `Exit code: ${this.exitCode}`)
      }
      this.contentContainer.addChild(new Text(statusText, 1, 0))
    } else {
      this.contentContainer.addChild(this.loader)
    }

    // Show output lines
    for (const line of this.outputLines) {
      if (line.trim()) {
        this.contentContainer.addChild(new Text(line, 1, 0))
      }
    }
  }
}
