import type { Component } from '@earendil-works/pi-tui'
import { getKeybindings, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

export interface MultiSelectItem {
  value: string
  label: string
  description?: string
  /** When true, the item cannot be selected and is shown dimmed. */
  disabled?: boolean
}

export interface MultiSelectListTheme {
  selectedText: (text: string) => string
  disabledText: (text: string) => string
  description: (text: string) => string
  scrollInfo: (text: string) => string
}

/**
 * A list component that allows selecting multiple items.
 *
 * - ↑/↓ navigate (wrapping)
 * - Space toggles the current item (disabled items are skipped)
 * - Enter confirms and calls onConfirm with selected items
 * - Escape / Ctrl+C calls onCancel
 */
export class MultiSelectList implements Component {
  private readonly selected = new Set<number>()
  private cursorIndex = 0

  onConfirm?: (items: MultiSelectItem[]) => void
  onCancel?: () => void

  constructor(
    private readonly items: MultiSelectItem[],
    private readonly maxVisible: number,
    private readonly theme: MultiSelectListTheme,
    preSelected?: number[],
  ) {
    if (preSelected) {
      for (const idx of preSelected) {
        if (idx >= 0 && idx < items.length && items[idx]?.disabled !== true) {
          this.selected.add(idx)
        }
      }
    }
  }

  invalidate(): void {
    // No cached state to invalidate
  }

  render(width: number): string[] {
    const lines: string[] = []

    if (this.items.length === 0) {
      lines.push(this.theme.description('  No items'))
      lines.push(this.theme.description('  Enter: confirm  Esc: back'))
      return lines
    }

    // Clamp cursor
    const cursorIndex = Math.max(0, Math.min(this.cursorIndex, this.items.length - 1))

    // Calculate visible range (cursor centered)
    const halfVisible = Math.floor(this.maxVisible / 2)
    let startIndex = cursorIndex - halfVisible
    let endIndex = startIndex + this.maxVisible

    if (startIndex < 0) {
      startIndex = 0
      endIndex = Math.min(this.maxVisible, this.items.length)
    }
    if (endIndex > this.items.length) {
      endIndex = this.items.length
      startIndex = Math.max(0, endIndex - this.maxVisible)
    }

    // Scroll indicator at top
    if (startIndex > 0) {
      lines.push(this.theme.scrollInfo(`  ↑ ${startIndex} more above`))
    }

    // Compute fixed primary column width from all items so descriptions align
    const prefixWidth = 4 // cursor(1) + checkbox(3) = 4
    const contentWidth = width - prefixWidth
    const PRIMARY_COLUMN_GAP = 2

    let widestLabel = 0
    for (const item of this.items) {
      const w = visibleWidth(item.label)
      if (w > widestLabel) widestLabel = w
    }
    const minPrimary = Math.min(24, contentWidth - 14)
    const maxPrimary = Math.max(minPrimary, Math.floor(contentWidth * 0.55))
    const primaryWidth = Math.max(minPrimary, Math.min(widestLabel + PRIMARY_COLUMN_GAP, maxPrimary))

    // Render visible items
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.items[i]
      if (!item) continue

      const isCursor = i === cursorIndex
      const isChecked = this.selected.has(i)
      const disabled = item.disabled === true

      // Determine checkbox
      let checkbox: string
      if (disabled) {
        checkbox = ' ⨯ '
      } else if (isChecked) {
        checkbox = ' ◆ '
      } else {
        checkbox = ' ○ '
      }

      // Cursor prefix
      const cursor = isCursor ? '→' : ' '

      // Build the line content
      const prefix = `${cursor}${checkbox}`
      const label = item.label
      const desc = item.description ? `  ${item.description}` : ''

      let line: string
      if (desc && width > 50) {
        // Two-column layout with fixed primary column
        const labelTruncated = truncateToWidth(label, primaryWidth, '…')
        const labelVisWidth = visibleWidth(labelTruncated)
        const spacing = ' '.repeat(Math.max(1, primaryWidth - labelVisWidth))
        const descWidth = width - prefixWidth - primaryWidth - 1
        const descTruncated = descWidth > 4
          ? truncateToWidth(desc, descWidth, '…')
          : ''
        line = `${prefix}${labelTruncated}${spacing}${descTruncated}`
      } else {
        const truncated = truncateToWidth(`${prefix}${label}`, width, '…')
        line = truncated
      }

      if (disabled) {
        line = this.theme.disabledText(line)
      } else if (isCursor) {
        line = this.theme.selectedText(line)
      }

      lines.push(line)
    }

    // Scroll indicator at bottom
    if (endIndex < this.items.length) {
      lines.push(this.theme.scrollInfo(`  ↓ ${this.items.length - endIndex} more below`))
    }

    // Hint line
    const selectedCount = this.selected.size
    const hint = selectedCount > 0
      ? `Space: toggle  Enter: confirm (${selectedCount} selected)  Esc: back`
      : 'Space: toggle  Enter: confirm  Esc: back'
    lines.push(this.theme.description(`  ${hint}`))

    return lines
  }

  handleInput(data: string): void {
    const kb = getKeybindings()

    if (kb.matches(data, 'tui.select.up')) {
      this.cursorIndex =
        this.cursorIndex === 0
          ? this.items.length - 1
          : this.cursorIndex - 1
      this.ensureCursorOnEnabled('up')
    } else if (kb.matches(data, 'tui.select.down')) {
      this.cursorIndex =
        this.cursorIndex === this.items.length - 1
          ? 0
          : this.cursorIndex + 1
      this.ensureCursorOnEnabled('down')
    } else if (kb.matches(data, 'tui.select.confirm')) {
      const selectedItems: MultiSelectItem[] = []
      for (const idx of this.selected) {
        const item = this.items[idx]
        if (item) selectedItems.push(item)
      }
      this.onConfirm?.(selectedItems)
    } else if (kb.matches(data, 'tui.select.cancel')) {
      this.onCancel?.()
    } else if (data === ' ') {
      const item = this.items[this.cursorIndex]
      if (item && !item.disabled) {
        if (this.selected.has(this.cursorIndex)) {
          this.selected.delete(this.cursorIndex)
        } else {
          this.selected.add(this.cursorIndex)
        }
      }
    }
  }

  /** If the cursor lands on a disabled item, skip to the next enabled one. */
  private ensureCursorOnEnabled(direction: 'up' | 'down'): void {
    const allDisabled = this.items.every((item) => item.disabled === true)
    if (allDisabled) return

    // Try to move the cursor a few times but don't loop forever
    for (let attempt = 0; attempt < this.items.length; attempt++) {
      const item = this.items[this.cursorIndex]
      if (!item || item.disabled !== true) return

      if (direction === 'up') {
        this.cursorIndex =
          this.cursorIndex === 0
            ? this.items.length - 1
            : this.cursorIndex - 1
      } else {
        this.cursorIndex =
          this.cursorIndex === this.items.length - 1
            ? 0
            : this.cursorIndex + 1
      }
    }
  }
}
