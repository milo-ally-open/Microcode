import { type Component, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import chalk from 'chalk'
import { GitBranchReader } from '../../git/index.ts'
import type { MicrocodeAgent } from '../../agent/index.ts'
import { normalizeSessionTitle } from '../sessionTitle.ts'

function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
  return `${Math.round(count / 1000000)}M`
}

function getContextColor(percentUsed: number): string {
  if (percentUsed >= 85) return '#cc6666'
  if (percentUsed >= 70) return '#cc9966'
  return '#669966'
}

export class FooterComponent implements Component {
  private sessionTitle: string | null = null
  private readonly gitBranch: GitBranchReader

  constructor(
    private readonly agent: MicrocodeAgent,
    private readonly cwd: string,
  ) {
    this.gitBranch = new GitBranchReader(cwd)
  }

  setSessionTitle(title: string | null): void {
    this.sessionTitle = title === null ? null : normalizeSessionTitle(title)
  }

  invalidate(): void {
    this.gitBranch.refresh()
  }

  render(width: number): string[] {
    const lines: string[] = []
    const snapshot = this.agent.getSnapshot()
    const sessionUsage = snapshot.tokens.session
    const contextUsage = snapshot.tokens.context

    if (this.sessionTitle) {
      const titleText = truncateToWidth(`Title: ${this.sessionTitle}`, width, '...')
      lines.push(chalk.hex('#999999')(titleText))
    }

    let pwd = this.cwd
    const home = process.env.HOME || process.env.USERPROFILE
    if (home && pwd.startsWith(home)) {
      pwd = `~${pwd.slice(home.length)}`
    }
    const gitBranch = this.gitBranch.getBranch()
    if (gitBranch) {
      pwd = `${pwd} (${gitBranch})`
    }

    const statsParts: string[] = []
    if (sessionUsage.inputTokens) statsParts.push(`in:${formatTokens(sessionUsage.inputTokens)}`)
    if (sessionUsage.outputTokens) statsParts.push(`out:${formatTokens(sessionUsage.outputTokens)}`)
    if (sessionUsage.totalCost) statsParts.push(`$${sessionUsage.totalCost.toFixed(3)}`)
    statsParts.push(
      chalk.hex(getContextColor(contextUsage.percentUsed))(`ctx:${contextUsage.percentUsed}%`),
    )
    const statsLeft = chalk.hex('#666666')(`${pwd}  `) +
      statsParts.join(chalk.hex('#666666')(' '))
    const thinking = snapshot.thinkingLevel !== 'off'
      ? chalk.hex('#00d7ff')(` • ${snapshot.thinkingLevel}`)
      : ''
    const rightSide = chalk.hex('#666666')(
      `(${snapshot.model.provider}) ${snapshot.model.id}`,
    ) + thinking

    const statsLeftWidth = visibleWidth(statsLeft)
    const rightSideWidth = visibleWidth(rightSide)
    let statsLine: string
    if (statsLeftWidth + 2 + rightSideWidth <= width) {
      statsLine = statsLeft + ' '.repeat(width - statsLeftWidth - rightSideWidth) + rightSide
    } else if (statsLeftWidth <= width) {
      statsLine = statsLeft
    } else {
      statsLine = truncateToWidth(statsLeft, width, '...')
    }

    lines.push(statsLine)
    return lines
  }
}
