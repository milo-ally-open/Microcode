import { Editor, type EditorOptions, type EditorTheme, type TUI } from '@earendil-works/pi-tui'
import chalk from 'chalk'
import { highlightSkillMentions } from '../skillMentions.ts'
import { highlightWorkspaceFileMentions } from '../workspaceFiles.ts'
import { highlightPluginMentions } from '../pluginMentions.ts'

const MENTION_COLORS = {
  skill: '#ff79c6',
  plugin: '#ffd866',
  file: '#00d7ff',
} as const

export function autocompleteMaxVisibleForHeight(height: number): number {
  // 为标题、输入框、footer 和至少一行对话留空间，其余空间交给候选列表（上限沿用 pi-tui 的 20 项）。
  return Math.max(3, Math.min(20, Math.floor(height) - 14))
}

/**
 * Editor subclass that adds app-level key handlers for Microcode.
 * Handles Escape, Ctrl+C, Ctrl+D before the base Editor processes them,
 * while letting the Editor handle everything else (cursor, history, undo, autocomplete).
 */
export class MicrocodeEditor extends Editor {
  getPluginNames?: () => readonly string[]
  public onEscape?: () => void
  public onCtrlC?: () => void
  public onCtrlD?: () => void
  public onPasteImage?: () => void

  constructor(tui: TUI, theme: EditorTheme, options?: EditorOptions) {
    super(tui, theme, {
      ...options,
      autocompleteMaxVisible: autocompleteMaxVisibleForHeight(tui.terminal.rows),
    })
  }

  render(width: number): string[] {
    const maxVisible = autocompleteMaxVisibleForHeight(this.tui.terminal.rows)
    if (this.getAutocompleteMaxVisible() !== maxVisible) this.setAutocompleteMaxVisible(maxVisible)

    const lines = super.render(width)
    if (this.isShowingAutocomplete()) {
      // pi-tui appends autocomplete rows after the editor. Move those rows ahead
      // of the input frame so suggestions don't consume space below the prompt.
      const editor = this as unknown as {
        autocompleteList?: { render: (width: number) => string[] }
      }
      const autocompleteList = editor.autocompleteList
      if (autocompleteList) {
        const paddingX = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)))
        const contentWidth = Math.max(1, width - paddingX * 2)
        const autocompleteLineCount = autocompleteList.render(contentWidth).length
        const splitIndex = Math.max(0, lines.length - autocompleteLineCount)
        return [...lines.slice(splitIndex), ...lines.slice(0, splitIndex)]
      }
      return lines
    }
    return lines.map((line) => highlightWorkspaceFileMentions(
      highlightPluginMentions(
        highlightSkillMentions(line, (mention) => chalk.hex(MENTION_COLORS.skill).bold(mention)),
        this.getPluginNames?.() ?? [],
        (mention) => chalk.hex(MENTION_COLORS.plugin).bold(mention),
      ),
      (mention) => chalk.hex(MENTION_COLORS.file).bold(mention),
    ))
  }

  handleInput(data: string): void {
    // Ctrl+V and Shift+Insert are common terminal clipboard paste shortcuts.
    // Image-only clipboard data has no text sequence for the Editor to paste.
    if (data === '\x16' || data === '\x1b[2~' || data === '\x1b[2;2~') {
      this.onPasteImage?.()
      return
    }
    if (this.handleAppShortcuts(data)) return

    const shouldOpenSkills = data === '$' && this.isAtSkillMentionBoundary()
    const shouldOpenPlugins = data === '#' && this.isAtPluginMentionBoundary()
    super.handleInput(data)
    if (shouldOpenSkills) this.triggerSkillAutocomplete()
    if (shouldOpenPlugins) this.triggerSkillAutocomplete()
  }

  private isAtSkillMentionBoundary(): boolean {
    const { line, col } = this.getCursor()
    const previousCharacter = (this.getLines()[line] ?? '')[col - 1]
    return col === 0 || previousCharacter === undefined || /[\s([{]/.test(previousCharacter)
  }

  private isAtPluginMentionBoundary(): boolean {
    const { line, col } = this.getCursor()
    const previousCharacter = (this.getLines()[line] ?? '')[col - 1]
    return col === 0 || previousCharacter === undefined || /[\s([{]/.test(previousCharacter)
  }

  private triggerSkillAutocomplete(): void {
    // pi-tui currently exposes no public method for opening symbol autocomplete
    // on a custom trigger. Keep this compatibility call localized here.
    const editor = this as unknown as {
      tryTriggerAutocomplete?: (explicitTab?: boolean) => void
    }
    editor.tryTriggerAutocomplete?.call(this)
  }

  private handleAppShortcuts(data: string): boolean {
    // Escape — only if autocomplete is NOT active
    if (data === '\x1b') {
      if (!this.isShowingAutocomplete()) {
        this.onEscape?.()
        return true
      }
      // Let Editor handle Escape for autocomplete cancellation
    }

    // Ctrl+C
    if (data === '\x03') {
      this.onCtrlC?.()
      return true
    }

    // Ctrl+D — only when editor is empty
    if (data === '\x04') {
      if (this.getText().length === 0) {
        this.onCtrlD?.()
        return true
      }
      // Fall through to Editor for delete-char-forward when not empty
    }

    return false
  }
}
