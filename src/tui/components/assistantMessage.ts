import { Container, type MarkdownTheme } from '@earendil-works/pi-tui'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { getMarkdownTheme, theme } from '../theme.ts'
import { MarkedMarkdown } from './markedMarkdown.ts'

/**
 * Component that renders user-visible assistant text; thinking stays out of transcript rows.
 * Supports streaming updates via updateContent().
 */
export class AssistantMessageComponent extends Container {
  private textComponents: MarkedMarkdown[] = []
  private markdownTheme: MarkdownTheme
  private lastText = ''
  private lastBlockSignature = ''

  constructor(markdownTheme: MarkdownTheme = getMarkdownTheme()) {
    super()
    this.markdownTheme = markdownTheme
  }

  updateContent(message: AssistantMessage): void {
    const blocks = message.content
    const textBlocks = blocks.filter((c) => c.type === 'text')
    const text = textBlocks.map((c) => c.text).join('')

    // Build a signature that captures block types and whether text blocks have content.
    // This ensures we rebuild when a text block transitions from empty to non-empty
    // (e.g. when thinking finishes and the answer starts streaming).
    const signature = blocks
      .map((b) => b.type === 'text' ? `text:${b.text.length > 0 ? '1' : '0'}` : b.type)
      .join(',')

    if (signature !== this.lastBlockSignature) {
      this.lastBlockSignature = signature
      this.clear()
      this.textComponents = []
      for (const block of blocks) {
        if (block.type === 'text') {
          const md = new MarkedMarkdown(
            block.text.trim() ? block.text : ' ',
            theme.fg('muted', '• '),
            0,
            this.markdownTheme,
          )
          this.addChild(md)
          this.textComponents.push(md)
        }
      }

      this.lastText = text
      return
    }

    // Signature unchanged — update the last block's content for streaming
    if (text !== this.lastText) {
      const lastTextBlock = [...blocks].reverse().find((block) => block.type === 'text')
      const lastTextComponent = this.textComponents.at(-1)

      if (lastTextBlock?.type === 'text' && lastTextComponent) {
        lastTextComponent.setText(lastTextBlock.text.trim() ? lastTextBlock.text : ' ')
      }

      this.lastText = text
    }
  }

  getText(): string {
    return this.lastText
  }
}
