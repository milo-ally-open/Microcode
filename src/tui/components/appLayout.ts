import { matchesKey, type Component, visibleWidth } from '@earendil-works/pi-tui'
import { theme } from '../theme.ts'
import type { ToolInteractionTarget } from '../../tools/registry.ts'

const RETURN_TO_BOTTOM_LABEL = 'Return to bottom'

/** Keeps the prompt/footer fixed while the conversation uses the remaining rows. */
export class AppLayout implements Component {
  private scrollTop: number | undefined
  private lastViewportHeight = 1
  private lastMaxTop = 0
  private scrollbarTrackTop = 0
  private scrollbarTrackLength = 0
  private scrollbarThumbStart = 0
  private scrollbarThumbLength = 0
  private scrollbarColumn = 0
  private draggingScrollbar = false
  private scrollbarDragOffset = 0
  private returnButtonRow = 0
  private returnButtonStartColumn = 0
  private returnButtonEndColumn = 0
  private toolToggleButtons: Array<ToolInteractionTarget & { row: number }> = []
  private lastTogglePress?: { row: number; at: number }

  constructor(
    private readonly header: Component,
    private readonly chat: Component,
    private readonly bottom: Component[],
    private readonly getHeight: () => number,
    private readonly getToolInteractionTargets: (width: number) => ToolInteractionTarget[] = () => [],
  ) {}

  /** Scroll continuously by rendered chat rows; positive values move toward newer content. */
  scrollBy(delta: number): boolean {
    if (this.lastMaxTop <= 0 || delta === 0) return false
    const currentTop = this.scrollTop ?? this.lastMaxTop
    const nextTop = Math.max(0, Math.min(this.lastMaxTop, currentTop + Math.trunc(delta)))
    if (nextTop === currentTop) return false
    this.scrollTop = nextTop >= this.lastMaxTop ? undefined : nextTop
    return true
  }

  handleInput(data: string, autocompleteVisible = false): boolean {
    const mouse = this.parseMouseInput(data)
    if (!mouse) {
      if (autocompleteVisible) return false
      if (matchesKey(data, 'pageUp')) return this.scrollBy(-this.lastViewportHeight)
      if (matchesKey(data, 'pageDown')) return this.scrollBy(this.lastViewportHeight)
      return false
    }
    const { button, column, row, pressed } = mouse
    const buttonCode = button & 3
    const isWheel = (button & 64) !== 0
    const isLeftClick = !isWheel && (buttonCode === 0 || (!pressed && buttonCode === 3))
    const isMotion = (button & 32) !== 0

    if (this.draggingScrollbar) {
      if (!pressed && !isWheel) {
        this.draggingScrollbar = false
        return true
      }
      if (isMotion || (pressed && isLeftClick)) {
        this.scrollScrollbarTo(row)
        return true
      }
    }

    if (isLeftClick && !isMotion) {
      if (
        column === this.scrollbarColumn &&
        row >= this.scrollbarTrackTop &&
        row < this.scrollbarTrackTop + this.scrollbarTrackLength
      ) {
        this.draggingScrollbar = true
        const trackOffset = row - this.scrollbarTrackTop
        const thumbEnd = this.scrollbarThumbStart + this.scrollbarThumbLength
        this.scrollbarDragOffset = trackOffset >= this.scrollbarThumbStart && trackOffset < thumbEnd
          ? trackOffset - this.scrollbarThumbStart
          : Math.floor(this.scrollbarThumbLength / 2)
        this.scrollScrollbarTo(row)
        return true
      }

      const toggle = this.toolToggleButtons.find((item) =>
        item.row === row && column >= item.startColumn && column <= item.endColumn,
      )
      if (toggle) {
        if (!pressed && this.lastTogglePress?.row === row) {
          const releasedQuickly = Date.now() - this.lastTogglePress.at < 1_000
          this.lastTogglePress = undefined
          if (releasedQuickly) return true
        }

        toggle.activate()
        this.lastTogglePress = pressed ? { row, at: Date.now() } : undefined
        return true
      }

      if (
        this.scrollTop !== undefined && row === this.returnButtonRow &&
        column >= this.returnButtonStartColumn && column <= this.returnButtonEndColumn
      ) {
        this.followLatest()
        return true
      }
    }

    if (autocompleteVisible) return false
    if (isWheel) return this.scrollBy((button & 1) === 0 ? -3 : 3)
    return false
  }

  private parseMouseInput(data: string): { button: number; column: number; row: number; pressed: boolean } | undefined {
    const sgr = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/)
    if (sgr) {
      return {
        button: Number(sgr[1]),
        column: Number(sgr[2]),
        row: Number(sgr[3]),
        pressed: sgr[4] === 'M',
      }
    }

    // Accept legacy X10 reports from terminals that ignore SGR mouse mode.
    if (data.startsWith('\x1b[M') && data.length === 6) {
      return {
        button: data.charCodeAt(3) - 32,
        column: data.charCodeAt(4) - 32,
        row: data.charCodeAt(5) - 32,
        pressed: true,
      }
    }

    return undefined
  }

  private scrollScrollbarTo(row: number): void {
    const movableTrack = this.scrollbarTrackLength - this.scrollbarThumbLength
    if (movableTrack <= 0 || this.lastMaxTop <= 0) return
    const thumbStart = Math.max(
      0,
      Math.min(movableTrack, row - this.scrollbarTrackTop - this.scrollbarDragOffset),
    )
    const nextTop = Math.round((thumbStart / movableTrack) * this.lastMaxTop)
    this.scrollTop = nextTop >= this.lastMaxTop ? undefined : nextTop
  }

  followLatest(): void {
    this.scrollTop = undefined
  }

  render(width: number): string[] {
    const headerLines = this.header.render(width)
    const chatWidth = Math.max(1, width - 1)
    const chatLines = this.chat.render(chatWidth)
    const bottomLines = this.bottom.flatMap((component) => component.render(width))
    const height = Math.max(1, Math.floor(this.getHeight()))
    const chatHeight = Math.max(0, height - headerLines.length - bottomLines.length)
    const showScrollHint = chatHeight > 1 && (chatLines.length > chatHeight || this.scrollTop !== undefined)
    const showReturnButton = showScrollHint && this.scrollTop !== undefined
    this.lastViewportHeight = Math.max(1, chatHeight - (showScrollHint ? 1 : 0))
    const maxTop = Math.max(0, chatLines.length - this.lastViewportHeight)
    this.lastMaxTop = maxTop
    const top = this.scrollTop === undefined ? maxTop : Math.min(this.scrollTop, maxTop)
    if (maxTop === 0) this.scrollTop = undefined
    const visibleChat = chatLines.slice(top, top + this.lastViewportHeight)
    this.scrollbarColumn = width
    this.scrollbarTrackTop = headerLines.length + 1
    this.scrollbarTrackLength = maxTop > 0 ? visibleChat.length : 0
    this.scrollbarThumbLength = this.scrollbarTrackLength > 0
      ? Math.max(1, Math.floor(this.scrollbarTrackLength * this.lastViewportHeight / chatLines.length))
      : 0
    const movableTrack = this.scrollbarTrackLength - this.scrollbarThumbLength
    this.scrollbarThumbStart = movableTrack > 0
      ? Math.round((top / maxTop) * movableTrack)
      : 0
    this.toolToggleButtons = this.getToolInteractionTargets(chatWidth)
      .filter((target) => target.rowOffset >= top && target.rowOffset < top + visibleChat.length)
      .map((target) => ({
        ...target,
        row: headerLines.length + target.rowOffset - top + 1,
      }))
    const controlLine = showReturnButton
      ? theme.fg('accent', `  [ ${RETURN_TO_BOTTOM_LABEL} ]`)
      : showScrollHint
        ? theme.dim('↕ Scroll: mouse wheel · PgUp/PgDn')
        : undefined
    const controlLines = controlLine === undefined ? [] : [controlLine]
    this.returnButtonRow = showReturnButton ? headerLines.length + visibleChat.length + 1 : 0
    this.returnButtonStartColumn = 3
    this.returnButtonEndColumn = 2 + visibleWidth(`[ ${RETURN_TO_BOTTOM_LABEL} ]`)
    const spacerHeight = Math.max(0, height - headerLines.length - controlLines.length - visibleChat.length - bottomLines.length)
    const chatWithScrollbar = visibleChat.map((line, index) => {
      const lineWidth = visibleWidth(line)
      const padding = ' '.repeat(Math.max(0, chatWidth - lineWidth))
      const thumb = index >= this.scrollbarThumbStart && index < this.scrollbarThumbStart + this.scrollbarThumbLength
      const marker = this.scrollbarTrackLength > 0
        ? (thumb ? theme.fg('accent', '█') : theme.dim('│'))
        : ' '
      return `${line}${padding}${marker}`
    })

    // 对话只占输入区上方的可用行；超出时裁掉顶部旧内容，避免把输入区挤出视口。
    return [
      ...headerLines,
      ...chatWithScrollbar,
      ...controlLines,
      ...Array.from({ length: spacerHeight }, () => ''),
      ...bottomLines,
    ]
  }
}
