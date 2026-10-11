import chalk from 'chalk'
import type { MarkdownTheme } from '@earendil-works/pi-tui'

// Color constants matching pi-coding-agent dark theme
const COLORS = {
  accent: '#8abeb7',
  logo: '#7ce8f5',
  cyan: '#00d7ff',
  green: '#b5bd68',
  red: '#cc6666',
  yellow: '#ffff00',
  text: '#ffffff',
  gray: '#808080',
  dimGray: '#666666',
}

export const theme = {
  fg: (color: string, text: string) => {
    switch (color) {
      case 'accent': return chalk.hex(COLORS.accent)(text)
      case 'logo': return chalk.hex(COLORS.logo)(text)
      case 'dim': return chalk.hex(COLORS.dimGray)(text)
      case 'muted': return chalk.hex(COLORS.gray)(text)
      case 'error': return chalk.hex(COLORS.red)(text)
      case 'warning': return chalk.hex(COLORS.yellow)(text)
      case 'success': return chalk.hex(COLORS.green)(text)
      case 'text': return chalk.hex(COLORS.text)(text)
      default: return text
    }
  },
  bold: (text: string) => chalk.bold(text),
  dim: (text: string) => chalk.hex(COLORS.dimGray)(text),
}

export function getMarkdownTheme(): MarkdownTheme {
  return {
    heading: (text: string) => chalk.hex('#f0c674').bold(text),
    link: (text: string) => chalk.hex(COLORS.text).underline(text),
    linkUrl: (text: string) => chalk.hex(COLORS.dimGray)(text),
    code: (text: string) => chalk.hex(COLORS.accent)(text),
    codeBlock: (text: string) => chalk.hex(COLORS.green)(text),
    codeBlockBorder: (text: string) => chalk.hex(COLORS.gray)(text),
    quote: (text: string) => chalk.hex(COLORS.gray).italic(text),
    quoteBorder: (text: string) => chalk.hex(COLORS.gray)(text),
    hr: (text: string) => chalk.hex(COLORS.gray)(text),
    listBullet: (text: string) => chalk.hex(COLORS.accent)(text),
    bold: (text: string) => chalk.bold(text),
    italic: (text: string) => chalk.italic(text),
    strikethrough: (text: string) => chalk.strikethrough(text),
    underline: (text: string) => chalk.underline(text),
  }
}

export function getEditorTheme() {
  return {
    borderColor: (text: string) => chalk.hex(COLORS.gray)(text),
    selectList: {
      selectedPrefix: (text: string) => chalk.hex(COLORS.cyan)(text),
      selectedText: (text: string) => chalk.hex(COLORS.cyan).bold(text),
      description: (text: string) => chalk.hex(COLORS.gray)(text),
      scrollInfo: (text: string) => chalk.hex(COLORS.gray)(text),
      noMatch: (text: string) => chalk.hex(COLORS.gray)(text),
    },
  }
}

export function getBashModeBorderColor(): (text: string) => string {
  return (text: string) => chalk.hex(COLORS.accent)(text)
}
