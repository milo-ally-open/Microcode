import { type Component, type DefaultTextStyle, type MarkdownTheme } from '@earendil-works/pi-tui'
import { Markdown } from './markdown.ts'

/** Adds a compact chat marker and a hanging indent to rendered Markdown. */
export class MarkedMarkdown implements Component {
  private markdown: Markdown

  constructor(
    text: string,
    private readonly marker: string,
    paddingY: number,
    markdownTheme: MarkdownTheme,
    defaultTextStyle?: DefaultTextStyle,
  ) {
    this.markdown = new Markdown(text, 0, paddingY, markdownTheme, defaultTextStyle)
  }

  setText(text: string): void {
    this.markdown.setText(text)
  }

  render(width: number): string[] {
    const content = this.markdown.render(Math.max(1, width - 2))
    if (content.length === 0) return []
    return content.map((line, index) => `${index === 0 ? this.marker : '  '}${line}`)
  }

  invalidate(): void {
    this.markdown.invalidate()
  }
}
