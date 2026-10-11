import { Container, Text, type Component } from '@earendil-works/pi-tui'
import chalk from 'chalk'
import type { ToolInteractionTarget, ToolUIComponent } from '../../tools/registry.ts'

type EntryKind = 'user' | 'assistant' | 'tool' | 'status'

interface TimelineEntry {
  component: Component
  kind: EntryKind
}

/** Renders one user turn as a connected vertical activity rail. */
export class TurnTimeline extends Container {
  private entries: TimelineEntry[] = []
  private activity?: Text
  private renderedWidth?: number
  private renderedToolTargets: ToolInteractionTarget[] = []

  addEntry(component: Component, kind: EntryKind = 'status'): void {
    // Streaming tool updates can revisit the same component. A timeline owns a
    // component once; inserting it twice renders duplicate transcript rows.
    if (this.entries.some((entry) => entry.component === component)) return
    if (this.activity) this.entries.pop()
    this.entries.push({ component, kind })
    if (this.activity) this.entries.push({ component: this.activity, kind: 'status' })
  }

  setActivity(label?: string): void {
    if (!label) {
      if (!this.activity) return
      this.entries = this.entries.filter((entry) => entry.component !== this.activity)
      this.activity = undefined
      return
    }

    if (!this.activity) {
      this.activity = new Text(label, 0, 0)
      this.entries.push({ component: this.activity, kind: 'status' })
      return
    }

    this.activity.setText(label)
  }

  getToolInteractionTargets(width: number): ToolInteractionTarget[] {
    return width === this.renderedWidth ? this.renderedToolTargets : []
  }

  render(width: number): string[] {
    this.renderedWidth = width
    this.renderedToolTargets = []
    if (this.entries.length === 0) return []

    const connected = this.entries.some((entry) => entry.kind === 'tool')
    if (!connected) {
      return this.entries.flatMap(({ component }) => component.render(width))
    }

    const lines: string[] = []
    const railWidth = 3
    const entryWidth = Math.max(1, width - railWidth)

    for (let entryIndex = 0; entryIndex < this.entries.length; entryIndex++) {
      const entry = this.entries[entryIndex]!
      const renderedWidth = entryIndex === 0 ? width : entryWidth
      const entryLines = entry.component.render(renderedWidth)
      if (entry.kind === 'tool') {
        const tool = entry.component as ToolUIComponent
        for (const target of tool.getInteractionTargets?.(entryLines) ?? []) {
          this.renderedToolTargets.push({
            ...target,
            rowOffset: lines.length + target.rowOffset,
            startColumn: target.startColumn + (entryIndex > 0 ? railWidth : 0),
            endColumn: target.endColumn + (entryIndex > 0 ? railWidth : 0),
          })
        }
      }
      if (entryIndex === 0) {
        lines.push(...entryLines)
        continue
      }

      const isLast = entryIndex === this.entries.length - 1
      const branch = isLast ? '└─ ' : '├─ '
      for (let lineIndex = 0; lineIndex < entryLines.length; lineIndex++) {
        const prefix = lineIndex === 0 ? branch : '│  '
        lines.push(chalk.white(prefix) + entryLines[lineIndex]!)
      }
    }

    return lines
  }

  invalidate(): void {
    for (const { component } of this.entries) component.invalidate?.()
  }
}

/** Renders chat children once and records preview hit targets in transcript coordinates. */
export class ChatTranscript extends Container {
  private renderedWidth?: number
  private renderedToolTargets: ToolInteractionTarget[] = []

  getToolInteractionTargets(width: number): ToolInteractionTarget[] {
    return width === this.renderedWidth ? this.renderedToolTargets : []
  }

  render(width: number): string[] {
    this.renderedWidth = width
    this.renderedToolTargets = []
    const lines: string[] = []

    for (const component of this.children) {
      const componentLines = component.render(width)
      const targets = component instanceof TurnTimeline
        ? component.getToolInteractionTargets(width)
        : (component as ToolUIComponent).getInteractionTargets?.(componentLines) ?? []

      this.renderedToolTargets.push(...targets.map((target) => ({
        ...target,
        rowOffset: lines.length + target.rowOffset,
      })))
      lines.push(...componentLines)
    }

    return lines
  }
}
