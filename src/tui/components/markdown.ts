import { Marked, type Token, type Tokens } from 'marked'
import {
  type Component,
  type DefaultTextStyle,
  type MarkdownTheme,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'

interface InlineStyleContext {
  applyText: (text: string) => string
}

const parser = new Marked({ gfm: true, breaks: false })

function padToWidth(line: string, width: number): string {
  return line + ' '.repeat(Math.max(0, width - visibleWidth(line)))
}

function stripBlockHtml(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

function normalizeText(text: string): string {
  return text.replace(/\t/g, '   ')
}

/**
 * Markdown renderer tuned for Microcode's TUI.
 *
 * pi-tui's bundled Markdown component intentionally mirrors source syntax for
 * several block types. That makes rich assistant output look half-rendered
 * (for example headings as "### title" and code blocks with raw fences).
 * This component keeps marked's CommonMark/GFM parser, but renders block
 * tokens into terminal-native shapes.
 */
export class Markdown implements Component {
  private cachedText?: string
  private cachedWidth?: number
  private cachedLines?: string[]

  constructor(
    private text: string,
    private paddingX: number,
    private paddingY: number,
    private theme: MarkdownTheme,
    private defaultTextStyle?: DefaultTextStyle,
  ) {}

  setText(text: string): void {
    this.text = text
    this.invalidate()
  }

  invalidate(): void {
    this.cachedText = undefined
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
      return this.cachedLines
    }

    if (!this.text || this.text.trim() === '') {
      this.cachedText = this.text
      this.cachedWidth = width
      this.cachedLines = []
      return []
    }

    const contentWidth = Math.max(1, width - this.paddingX * 2)
    const tokens = parser.lexer(normalizeText(this.text))
    const rendered = this.renderBlocks(tokens, contentWidth)
    const padded = this.applyPadding(rendered, width, contentWidth)

    this.cachedText = this.text
    this.cachedWidth = width
    this.cachedLines = padded
    return padded
  }

  private renderBlocks(tokens: Token[], width: number): string[] {
    const lines: string[] = []

    for (const token of tokens) {
      const blockLines = this.renderBlock(token, width)
      if (blockLines.length === 0) continue

      if (lines.length > 0 && lines[lines.length - 1] !== '') {
        lines.push('')
      }
      lines.push(...blockLines)
    }

    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop()
    }

    return lines
  }

  private renderBlock(token: Token, width: number): string[] {
    switch (token.type) {
      case 'space':
        return []
      case 'heading':
        return this.renderHeading(token as Tokens.Heading, width)
      case 'paragraph':
        return this.wrapStyledText(this.renderInline((token as Tokens.Paragraph).tokens ?? []), width)
      case 'text':
        return this.wrapStyledText(this.renderInline([token]), width)
      case 'code':
        return this.renderCode(token as Tokens.Code, width)
      case 'list':
        return this.renderList(token as Tokens.List, width, 0)
      case 'blockquote':
        return this.renderBlockquote(token as Tokens.Blockquote, width)
      case 'hr':
        return [this.theme.hr('─'.repeat(Math.min(width, 80)))]
      case 'table':
        return this.renderTable(token as Tokens.Table, width)
      case 'html':
        return stripBlockHtml(token.raw).map((line) => this.applyDefaultStyle(line))
      default:
        if ('text' in token && typeof token.text === 'string') {
          return this.wrapStyledText(this.applyDefaultStyle(token.text), width)
        }
        return []
    }
  }

  private renderHeading(token: Tokens.Heading, width: number): string[] {
    const text = this.renderInline(token.tokens, {
      applyText: (value) => this.theme.heading(this.theme.bold(value)),
    })

    if (token.depth === 1) {
      return [
        this.theme.heading(this.theme.bold(text)),
        this.theme.hr('─'.repeat(Math.min(width, Math.max(visibleWidth(text), 8)))),
      ]
    }

    if (token.depth === 2) {
      return [
        this.theme.heading(this.theme.bold(text)),
        this.theme.hr('─'.repeat(Math.min(width, Math.max(visibleWidth(text), 6)))),
      ]
    }

    const marker = token.depth === 3 ? '◆ ' : token.depth === 4 ? '› ' : '· '
    return this.wrapStyledText(this.theme.heading(marker) + text, width)
  }

  private renderCode(token: Tokens.Code, width: number): string[] {
    const label = token.lang ? ` ${token.lang.trim()} ` : ''
    const top = this.theme.codeBlockBorder(`┌${label}${'─'.repeat(Math.max(1, width - visibleWidth(label) - 1))}`)
    const bottom = this.theme.codeBlockBorder(`└${'─'.repeat(Math.max(1, width - 1))}`)
    const codeWidth = Math.max(1, width - 2)
    const lines = [top]

    const sourceLines = this.theme.highlightCode
      ? this.theme.highlightCode(token.text, token.lang)
      : (token.text.length > 0 ? token.text.split('\n').map((line) => this.theme.codeBlock(line)) : [this.theme.codeBlock('')])

    for (const sourceLine of sourceLines) {
      for (const wrapped of wrapTextWithAnsi(sourceLine, codeWidth)) {
        lines.push(this.theme.codeBlockBorder('│ ') + wrapped)
      }
    }

    lines.push(bottom)
    return lines
  }

  private renderList(token: Tokens.List, width: number, depth: number): string[] {
    const lines: string[] = []
    const start = typeof token.start === 'number' ? token.start : 1

    token.items.forEach((item, index) => {
      const marker = token.ordered ? `${start + index}. ` : '• '
      const task = item.task ? `${item.checked ? '☑' : '☐'} ` : ''
      const prefix = '  '.repeat(depth) + this.theme.listBullet(marker + task)
      const plainPrefixWidth = depth * 2 + visibleWidth(marker + task)
      const continuation = ' '.repeat(plainPrefixWidth)
      const itemWidth = Math.max(1, width - plainPrefixWidth)
      let wroteFirstLine = false

      for (const itemToken of item.tokens) {
        if (itemToken.type === 'list') {
          lines.push(...this.renderList(itemToken as Tokens.List, width, depth + 1))
          wroteFirstLine = true
          continue
        }

        const blockLines = this.renderBlock(itemToken, itemWidth)
        for (const blockLine of blockLines) {
          if (blockLine === '') continue
          for (const wrapped of wrapTextWithAnsi(blockLine, itemWidth)) {
            lines.push((wroteFirstLine ? continuation : prefix) + wrapped)
            wroteFirstLine = true
          }
        }
      }

      if (!wroteFirstLine) {
        lines.push(prefix.trimEnd())
      }
    })

    return lines
  }

  private renderBlockquote(token: Tokens.Blockquote, width: number): string[] {
    const contentWidth = Math.max(1, width - 2)
    const innerLines = this.renderBlocks(token.tokens, contentWidth)
    return innerLines.map((line) => (
      this.theme.quoteBorder('│ ') + this.theme.quote(line)
    ))
  }

  private renderTable(token: Tokens.Table, width: number): string[] {
    const rows = [token.header, ...token.rows]
    const columnCount = token.header.length
    if (columnCount === 0) return []

    const textRows = rows.map((row) => row.map((cell) => this.renderInline(cell.tokens)))
    const borderWidth = columnCount * 3 + 1
    const available = Math.max(columnCount, width - borderWidth)
    const naturalWidths = new Array<number>(columnCount).fill(1)

    for (const row of textRows) {
      row.forEach((cell, index) => {
        naturalWidths[index] = Math.max(naturalWidths[index], Math.min(30, visibleWidth(cell)))
      })
    }

    const widths = this.fitColumns(naturalWidths, available)
    const lines: string[] = []
    const border = (left: string, mid: string, right: string) =>
      left + widths.map((cellWidth) => '─'.repeat(cellWidth + 2)).join(mid) + right

    lines.push(this.theme.codeBlockBorder(border('┌', '┬', '┐')))
    lines.push(this.renderTableRow(textRows[0], widths, true))
    lines.push(this.theme.codeBlockBorder(border('├', '┼', '┤')))
    for (const row of textRows.slice(1)) {
      lines.push(this.renderTableRow(row, widths, false))
    }
    lines.push(this.theme.codeBlockBorder(border('└', '┴', '┘')))

    return lines
  }

  private fitColumns(widths: number[], available: number): number[] {
    const fitted = [...widths]
    let total = fitted.reduce((sum, width) => sum + width, 0)

    while (total > available) {
      const index = fitted.indexOf(Math.max(...fitted))
      if (fitted[index] <= 1) break
      fitted[index]--
      total--
    }

    while (total < available && fitted.length > 0) {
      fitted[total % fitted.length]++
      total++
    }

    return fitted
  }

  private renderTableRow(cells: string[], widths: number[], header: boolean): string {
    const renderedCells = widths.map((width, index) => {
      const content = cells[index] ?? ''
      const clipped = visibleWidth(content) > width
        ? wrapTextWithAnsi(content, width)[0] ?? ''
        : content
      const padded = padToWidth(clipped, width)
      return header ? this.theme.bold(padded) : padded
    })
    return `│ ${renderedCells.join(' │ ')} │`
  }

  private renderInline(tokens: Token[], context?: InlineStyleContext): string {
    const styleContext = context ?? { applyText: (text: string) => this.applyDefaultStyle(text) }
    let result = ''

    for (const token of tokens) {
      switch (token.type) {
        case 'text':
          result += token.tokens
            ? this.renderInline(token.tokens, styleContext)
            : styleContext.applyText(token.text)
          break
        case 'escape':
          result += styleContext.applyText(token.text)
          break
        case 'strong':
          result += this.theme.bold(this.renderInline(token.tokens ?? [], styleContext))
          break
        case 'em':
          result += this.theme.italic(this.renderInline(token.tokens ?? [], styleContext))
          break
        case 'del':
          result += this.theme.strikethrough(this.renderInline(token.tokens ?? [], styleContext))
          break
        case 'codespan':
          result += this.theme.code(token.text)
          break
        case 'br':
          result += '\n'
          break
        case 'link': {
          const label = this.theme.link(this.renderInline(token.tokens ?? [], styleContext))
          result += token.href && token.href !== token.text
            ? `${label}${this.theme.linkUrl(` (${token.href})`)}`
            : label
          break
        }
        case 'image':
          result += this.theme.link(`[Image: ${token.text || token.href}]`)
          break
        case 'html':
          result += styleContext.applyText(token.raw)
          break
        default:
          if ('text' in token && typeof token.text === 'string') {
            result += styleContext.applyText(token.text)
          }
      }
    }

    return result
  }

  private wrapStyledText(text: string, width: number): string[] {
    return wrapTextWithAnsi(text, width)
  }

  private applyDefaultStyle(text: string): string {
    let styled = text
    if (this.defaultTextStyle?.color) {
      styled = this.defaultTextStyle.color(styled)
    }
    if (this.defaultTextStyle?.bold) {
      styled = this.theme.bold(styled)
    }
    if (this.defaultTextStyle?.italic) {
      styled = this.theme.italic(styled)
    }
    if (this.defaultTextStyle?.strikethrough) {
      styled = this.theme.strikethrough(styled)
    }
    if (this.defaultTextStyle?.underline) {
      styled = this.theme.underline(styled)
    }
    return styled
  }

  private applyPadding(lines: string[], width: number, contentWidth: number): string[] {
    const left = ' '.repeat(this.paddingX)
    const right = ' '.repeat(this.paddingX)
    const bgColor = this.defaultTextStyle?.bgColor
    const contentLines = lines.flatMap((line) => {
      const wrapped = wrapTextWithAnsi(line, contentWidth)
      return wrapped.map((wrappedLine) => {
        const withMargins = left + wrappedLine + right
        const padded = padToWidth(withMargins, width)
        return bgColor ? bgColor(padded) : padded
      })
    })

    const empty = bgColor ? bgColor(' '.repeat(width)) : ' '.repeat(width)
    const verticalPadding = Array.from({ length: this.paddingY }, () => empty)
    return [...verticalPadding, ...contentLines, ...verticalPadding]
  }
}
