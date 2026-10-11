import { visibleWidth } from '@earendil-works/pi-tui'

import type { ToolInteractionTarget } from './registry.ts'

/** Shared collapsed-by-default state for tool output previews. */
export class ToolPreviewController {
  private expanded = false

  constructor(readonly defaultVisibleRows = 0) {}

  setExpanded(expanded: boolean): void {
    this.expanded = expanded
  }

  toggle(): void {
    this.expanded = !this.expanded
  }

  isExpanded(): boolean {
    return this.expanded
  }

  hasToggle(availableRows: number): boolean {
    return availableRows > this.defaultVisibleRows
  }

  visibleRows(availableRows: number): number {
    return this.expanded ? availableRows : Math.min(availableRows, this.defaultVisibleRows)
  }

  toggleLabel(): '[Expand preview]' | '[Collapse preview]' {
    return this.expanded ? '[Collapse preview]' : '[Expand preview]'
  }

  /** Tool views publish an explicit semantic action and its rendered hit region. */
  interactionTarget(
    renderedLines: readonly string[],
    activate: () => void,
  ): ToolInteractionTarget[] {
    const label = this.toggleLabel()
    const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/g
    for (let rowOffset = 0; rowOffset < renderedLines.length; rowOffset++) {
      const plain = (renderedLines[rowOffset] ?? '').replace(ansiPattern, '')
      const start = plain.lastIndexOf(label)
      if (start < 0) continue
      // Terminal mouse coordinates are 1-based; visibleWidth itself is 0-based.
      const startColumn = visibleWidth(plain.slice(0, start)) + 1
      return [{
        action: 'toggle-preview',
        rowOffset,
        startColumn,
        endColumn: startColumn + visibleWidth(label) - 1,
        activate,
      }]
    }
    return []
  }
}
