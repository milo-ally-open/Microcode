import { type Component, visibleWidth } from '@earendil-works/pi-tui'
import { COMPACT_LOGO_LINES, LOGO_LINES } from '../logo.ts'
import { theme } from '../theme.ts'

/** A bordered startup panel with a responsive pixel wordmark and concise hints. */
export class WelcomeBanner implements Component {
  render(width: number): string[] {
    const terminalWidth = Math.max(20, Math.floor(width))
    const contentWidth = terminalWidth - 4
    const logo = contentWidth >= 72
      ? LOGO_LINES
      : contentWidth >= 54
        ? COMPACT_LOGO_LINES
        : [theme.bold(theme.fg('accent', 'Microcode'))]

    const large = terminalWidth >= 80
    const description = large
      ? [
          'Agentic coding assistant for code, files, tools, and long-running sessions.',
          'Focused terminal work with multi-provider model routing.',
        ]
      : terminalWidth >= 60
        ? ['Agentic coding assistant · focused terminal work']
        : []
    const hints = large
      ? 'Esc interrupt · Ctrl+C/D exit · / commands · ! shell'
      : terminalWidth >= 60
        ? 'Esc interrupt · Ctrl+C/D exit · /help'
        : 'Esc · /help'

    const rows = [
      ...logo.map((line) => this.frame(this.styleLogo(line), terminalWidth)),
      this.frame('', terminalWidth),
      ...description.map((line) => this.frame(theme.dim(line), terminalWidth)),
      this.frame(this.styleHints(hints), terminalWidth),
    ]

    return [
      theme.fg('muted', `╭${'─'.repeat(terminalWidth - 2)}╮`),
      ...rows,
      theme.fg('muted', `╰${'─'.repeat(terminalWidth - 2)}╯`),
    ]
  }

  private frame(content: string, width: number): string {
    const innerWidth = width - 4
    const padding = Math.max(0, innerWidth - visibleWidth(content))
    return `${theme.fg('muted', '│')} ${content}${' '.repeat(padding)} ${theme.fg('muted', '│')}`
  }

  private styleLogo(line: string): string {
    return line
      .replace(/█+/g, (pixels) => theme.bold(theme.fg('logo', pixels)))
      .replace(/▓+/g, (pixels) => theme.fg('dim', pixels))
  }

  private styleHints(hints: string): string {
    return hints.replace(/(Esc|Ctrl\+C\/D|Ctrl\+O|\/commands|\/help|!)/g, (key) => theme.fg('accent', key))
  }
}
