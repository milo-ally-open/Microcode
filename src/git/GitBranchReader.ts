import { execFileSync } from 'child_process'

const DEFAULT_REFRESH_INTERVAL_MS = 1000

/** Reads the current branch while avoiding a Git subprocess on every TUI redraw. */
export class GitBranchReader {
  private branch: string | null = null
  private lastReadAt = 0

  constructor(
    private readonly cwd: string,
    private readonly refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  ) {}

  getBranch(): string | null {
    if (Date.now() - this.lastReadAt >= this.refreshIntervalMs) {
      this.refresh()
    }
    return this.branch
  }

  refresh(): string | null {
    try {
      this.branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: this.cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    } catch {
      this.branch = null
    }

    this.lastReadAt = Date.now()
    return this.branch
  }
}
