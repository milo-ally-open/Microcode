import { execFile } from 'child_process'
import { isAbsolute, resolve, win32 } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 10 * 1024 * 1024

export interface GitFileChange {
  path: string
  indexStatus: string
  worktreeStatus: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
}

export interface GitRepositoryStatus {
  root: string
  branch: string
  upstream?: string
  ahead: number
  behind: number
  changes: GitFileChange[]
}

export interface GitBranch {
  name: string
  current: boolean
}

function commandError(error: unknown): string {
  const value = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string }
  if ((value as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return `Git output exceeded the ${Math.round(MAX_BUFFER / (1024 * 1024))} MiB safety limit; narrow the selected paths and try again.`
  }
  const stderr = value.stderr?.toString().trim()
  const stdout = value.stdout?.toString().trim()
  return (stderr || stdout || value.message || String(error))
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[credentials-redacted]@')
}

export class GitRepository {
  readonly root: string

  private constructor(root: string) {
    this.root = root
  }

  static async open(cwd: string): Promise<GitRepository> {
    try {
      const root = (await GitRepository.runAt(cwd, ['rev-parse', '--show-toplevel'])).trim()
      if (!root) throw new Error('Git returned an empty repository root.')
      return new GitRepository(resolve(root))
    } catch (error) {
      throw new Error(`Not inside a Git repository: ${cwd}. ${commandError(error)}`)
    }
  }

  async status(): Promise<GitRepositoryStatus> {
    const [branch, upstream, porcelain] = await Promise.all([
      this.currentBranch(),
      this.readUpstream(),
      this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ])
    let ahead = 0
    let behind = 0
    if (upstream) {
      const counts = (await this.run(['rev-list', '--left-right', '--count', `HEAD...${upstream}`])).trim().split(/\s+/)
      ahead = Number.parseInt(counts[0] ?? '', 10) || 0
      behind = Number.parseInt(counts[1] ?? '', 10) || 0
    }
    return { root: this.root, branch, upstream, ahead, behind, changes: this.parseChanges(porcelain) }
  }

  async branches(): Promise<GitBranch[]> {
    const output = await this.run(['for-each-ref', '--format=%(refname:short)%09%(HEAD)', 'refs/heads'])
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const [name = '', head = ''] = line.split('\t')
      return { name, current: head.trim() === '*' }
    })
  }

  async diff(staged = false, paths: string[] = []): Promise<string> {
    const args = ['diff', '--no-ext-diff', '--no-color']
    if (staged) args.push('--cached')
    if (paths.length > 0) args.push('--', ...paths)
    return this.run(args)
  }

  async history(limit = 20): Promise<string[]> {
    const output = await this.run([
      'log', `-n${Math.max(1, Math.min(100, limit))}`,
      '--date=short', '--pretty=format:%h%x09%ad%x09%s',
    ])
    return output.split(/\r?\n/).filter(Boolean)
  }

  async stage(paths: string[]): Promise<void> {
    this.requirePaths(paths)
    await this.run(['--literal-pathspecs', 'add', '--', ...paths])
  }

  async unstage(paths: string[]): Promise<void> {
    this.requirePaths(paths)
    try {
      await this.run(['--literal-pathspecs', 'restore', '--staged', '--', ...paths])
    } catch {
      await this.run(['--literal-pathspecs', 'reset', '--', ...paths])
    }
  }

  async discard(paths: string[]): Promise<void> {
    this.requirePaths(paths)
    const changes = await this.status()
    const byPath = new Map(changes.changes.map((change) => [change.path, change]))
    for (const path of paths) {
      const change = byPath.get(path)
      if (!change) throw new Error(`Path is no longer changed: ${path}`)
      if (!change.untracked && change.staged && !change.unstaged) {
        throw new Error(`Cannot discard staged-only changes for ${path}; unstage it first.`)
      }
    }
    for (const path of paths) {
      const change = byPath.get(path)
      if (!change) continue
      if (change.untracked) {
        await this.run(['--literal-pathspecs', 'clean', '-f', '--', path])
      } else {
        await this.run(['--literal-pathspecs', 'restore', '--worktree', '--', path])
      }
    }
  }

  async commit(message: string): Promise<string> {
    if (!message.trim()) throw new Error('Commit message cannot be empty.')
    await this.run(['commit', '-m', message])
    return (await this.run(['rev-parse', '--short', 'HEAD'])).trim()
  }

  async switchBranch(name: string): Promise<void> {
    this.requireBranchName(name)
    await this.run(['switch', name])
  }

  async createBranch(name: string): Promise<void> {
    this.requireBranchName(name)
    await this.run(['switch', '-c', name])
  }

  async deleteBranch(name: string): Promise<void> {
    this.requireBranchName(name)
    await this.run(['branch', '-d', name])
  }

  async fetch(): Promise<void> {
    await this.run(['fetch', '--all', '--prune'])
  }

  async pull(): Promise<void> {
    await this.run(['pull', '--ff-only'])
  }

  async push(): Promise<void> {
    await this.run(['push'])
  }

  async stashPush(message?: string): Promise<void> {
    await this.run(message?.trim()
      ? ['stash', 'push', '--include-untracked', '-m', message.trim()]
      : ['stash', 'push', '--include-untracked'])
  }

  async stashList(): Promise<string[]> {
    const output = await this.run(['stash', 'list', '--date=short', '--format=%gd%x09%ad%x09%s'])
    return output.split(/\r?\n/).filter(Boolean)
  }

  async stashApply(ref: string, pop = false): Promise<void> {
    if (!/^stash(?:@\{\d+\})?$/.test(ref)) throw new Error(`Invalid stash reference: ${ref}`)
    await this.run(['stash', pop ? 'pop' : 'apply', ref])
  }

  private async currentBranch(): Promise<string> {
    try {
      return (await this.run(['symbolic-ref', '--short', '-q', 'HEAD'])).trim() || 'HEAD (detached)'
    } catch {
      return 'HEAD (detached)'
    }
  }

  private async readUpstream(): Promise<string | undefined> {
    try {
      const upstream = (await this.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim()
      return upstream || undefined
    } catch {
      return undefined
    }
  }

  private parseChanges(output: string): GitFileChange[] {
    const records = output.split('\0')
    const changes: GitFileChange[] = []
    for (let i = 0; i < records.length; i++) {
      const record = records[i]
      if (!record) continue
      const indexStatus = record[0] ?? ' '
      const worktreeStatus = record[1] ?? ' '
      const path = record.slice(3)
      if (!path) continue
      changes.push({
        path,
        indexStatus,
        worktreeStatus,
        staged: indexStatus !== ' ' && indexStatus !== '?',
        unstaged: worktreeStatus !== ' ' && indexStatus !== '?',
        untracked: indexStatus === '?' && worktreeStatus === '?',
      })
      if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') {
        i++ // NUL-delimited porcelain emits the source path as an extra record.
      }
    }
    return changes
  }

  private requirePaths(paths: string[]): void {
    if (paths.length === 0 || paths.some((path) => !path || path.includes('\0'))) {
      throw new Error('Select at least one valid file path.')
    }
    for (const path of paths) {
      if (isAbsolute(path) || win32.isAbsolute(path) || path.replaceAll('\\', '/').split('/').includes('..')) {
        throw new Error(`Git paths must stay inside the repository: ${path}`)
      }
      if (resolve(this.root, path) === this.root) {
        throw new Error('Select a path inside the repository, not the repository root.')
      }
    }
  }

  private requireBranchName(name: string): void {
    if (!name.trim() || name.startsWith('-') || name.includes('\0')) {
      throw new Error('Enter a valid branch name.')
    }
  }

  private async run(args: string[]): Promise<string> {
    return GitRepository.runAt(this.root, args)
  }

  private static async runAt(cwd: string, args: string[]): Promise<string> {
    try {
      const result = await execFileAsync('git', args, { cwd, maxBuffer: MAX_BUFFER })
      return result.stdout
    } catch (error) {
      throw new Error(commandError(error))
    }
  }
}
