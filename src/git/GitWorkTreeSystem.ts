import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { access, mkdir } from 'fs/promises'
import { homedir } from 'os'
import { basename, join, resolve } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface GitWorkTree {
  id: string
  path: string
  branch: string
  baseCommit: string
  createdAt: number
  integratedAt?: number
}

export interface GitWorkTreeStatus extends GitWorkTree {
  changes: string[]
  ahead: number
}

export interface GitWorkTreeMergeResult {
  merged: boolean
  commit?: string
  message: string
}

export interface GitWorkTreeSystemOptions {
  worktreesRoot?: string
}

function commandError(error: unknown): string {
  const value = error as { stderr?: string; stdout?: string; message?: string }
  return value.stderr?.trim() || value.stdout?.trim() || value.message || String(error)
}

function isMissingCommand(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export class GitWorkTreeSystem {
  readonly repositoryRoot: string
  readonly worktreesRoot: string
  private readonly worktrees = new Map<string, GitWorkTree>()
  private mutationQueue: Promise<void> = Promise.resolve()

  private constructor(repositoryRoot: string, options: GitWorkTreeSystemOptions) {
    this.repositoryRoot = repositoryRoot
    const repoKey = createHash('sha256').update(repositoryRoot).digest('hex').slice(0, 12)
    this.worktreesRoot = options.worktreesRoot
      ? resolve(options.worktreesRoot)
      : join(homedir(), '.microcode', 'worktrees', `${basename(repositoryRoot)}-${repoKey}`)
  }

  static async open(
    cwd: string,
    options: GitWorkTreeSystemOptions = {},
  ): Promise<GitWorkTreeSystem> {
    try {
      await execFileAsync('git', ['--version'])
    } catch (error) {
      if (isMissingCommand(error)) {
        throw new Error(
          'Git is required to run microcode. Install Git and make sure the "git" command is available in PATH.',
        )
      }
      throw new Error(`Unable to run Git: ${commandError(error)}`)
    }

    let repositoryRoot: string
    try {
      const result = await execFileAsync(
        'git',
        ['rev-parse', '--show-toplevel'],
        { cwd },
      )
      repositoryRoot = result.stdout.trim()
    } catch {
      throw new Error(
        `Worktrees are only available inside a Git repository: ${cwd}`,
      )
    }

    return new GitWorkTreeSystem(repositoryRoot, options)
  }

  async create(id: string): Promise<GitWorkTree> {
    return this.withMutation(() => this.createUnlocked(id))
  }

  private async createUnlocked(id: string): Promise<GitWorkTree> {
    const existing = this.worktrees.get(id)
    if (existing) return { ...existing }
    this.assertId(id)
    await mkdir(this.worktreesRoot, { recursive: true })

    const baseCommit = (await this.git(['rev-parse', 'HEAD'])).trim()
    const branch = `microcode/${id}`
    const path = join(this.worktreesRoot, id)

    try {
      await access(path)
      throw new Error(`Worktree path already exists: ${path}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    try {
      await this.git(['worktree', 'add', '-b', branch, path, baseCommit])
    } catch (error) {
      throw new Error(`Failed to create worktree ${id}: ${commandError(error)}`)
    }

    const worktree: GitWorkTree = {
      id,
      path,
      branch,
      baseCommit,
      createdAt: Date.now(),
    }
    this.worktrees.set(id, worktree)
    return { ...worktree }
  }

  async restore(worktree: GitWorkTree): Promise<GitWorkTree> {
    return this.withMutation(() => this.restoreUnlocked(worktree))
  }

  private async restoreUnlocked(worktree: GitWorkTree): Promise<GitWorkTree> {
    this.assertId(worktree.id)
    try {
      await access(worktree.path)
    } catch {
      await mkdir(this.worktreesRoot, { recursive: true })
      await this.git(['worktree', 'add', worktree.path, worktree.branch])
    }
    this.worktrees.set(worktree.id, { ...worktree })
    return { ...worktree }
  }

  get(id: string): GitWorkTree | undefined {
    const worktree = this.worktrees.get(id)
    return worktree ? { ...worktree } : undefined
  }

  list(): GitWorkTree[] {
    return [...this.worktrees.values()].map((worktree) => ({ ...worktree }))
  }

  async status(id: string): Promise<GitWorkTreeStatus> {
    const worktree = this.require(id)
    const porcelain = await this.git(
      ['status', '--porcelain=v1', '--untracked-files=all'],
      worktree.path,
    )
    const aheadText = await this.git(
      ['rev-list', '--count', `${worktree.baseCommit}..HEAD`],
      worktree.path,
    )
    return {
      ...worktree,
      changes: porcelain.split('\n').filter(Boolean),
      ahead: Number.parseInt(aheadText.trim(), 10) || 0,
    }
  }

  async diff(id: string): Promise<string> {
    const worktree = this.require(id)
    const [trackedDiff, untracked, aheadText] = await Promise.all([
      this.git(['diff', '--no-ext-diff', '--binary', worktree.baseCommit], worktree.path),
      this.git(
        ['ls-files', '--others', '--exclude-standard'],
        worktree.path,
      ),
      this.git(
        ['rev-list', '--count', `${worktree.baseCommit}..${worktree.branch}`],
        worktree.path,
      ),
    ])
    const untrackedFiles = untracked.split('\n').filter(Boolean)
    const ahead = Number.parseInt(aheadText.trim(), 10) || 0

    const parts: string[] = []
    parts.push(`worktree: ${id}`)
    parts.push(`commits ahead of base: ${ahead}`)
    parts.push(`untracked files: ${untrackedFiles.length > 0 ? untrackedFiles.join(', ') : '(none)'}`)

    if (trackedDiff.trim()) {
      parts.push(`\n${trackedDiff.trim()}`)
    } else if (ahead === 0 && untrackedFiles.length === 0) {
      parts.push(`(no tracked changes or untracked files)`)
    } else if (ahead === 0 && untrackedFiles.length > 0) {
      parts.push(`(untracked files will be staged and committed during merge)`)
    }

    return parts.join('\n')
  }

  async merge(id: string): Promise<GitWorkTreeMergeResult> {
    return this.withMutation(() => this.mergeUnlocked(id))
  }

  private async mergeUnlocked(id: string): Promise<GitWorkTreeMergeResult> {
    const worktree = this.require(id)
    await this.assertMainWorkspaceClean()

    const status = await this.status(id)
    if (status.changes.length > 0) {
      await this.git(['add', '-A'], worktree.path)
      await this.git([
        '-c', 'user.name=Microcode',
        '-c', 'user.email=microcode@localhost',
        'commit', '-m', `microcode: worktree ${id}`,
      ], worktree.path)
    }

    const ahead = Number.parseInt(
      (await this.git(
        ['rev-list', '--count', `${worktree.baseCommit}..${worktree.branch}`],
      )).trim(),
      10,
    ) || 0
    if (ahead === 0) {
      return { merged: false, message: `Worktree ${id} has no changes to merge.` }
    }
    if (await this.isAncestor(worktree.branch, 'HEAD')) {
      worktree.integratedAt = Date.now()
      return {
        merged: false,
        message: `Worktree ${id} changes are already present in the main workspace.`,
      }
    }

    try {
      await this.git(['merge', '--no-ff', '--no-commit', worktree.branch])
      await this.git([
        '-c', 'user.name=Microcode',
        '-c', 'user.email=microcode@localhost',
        'commit', '-m', `Merge worktree ${id}`,
      ])
    } catch (error) {
      await this.git(['merge', '--abort']).catch(() => undefined)
      throw new Error(
        `Worktree ${id} could not be merged cleanly; the merge was aborted: ${commandError(error)}`,
      )
    }

    const commit = (await this.git(['rev-parse', 'HEAD'])).trim()
    worktree.integratedAt = Date.now()
    return {
      merged: true,
      commit,
      message: `Merged ${worktree.branch} into the main workspace at ${commit}.`,
    }
  }

  async remove(id: string, force = false): Promise<void> {
    return this.withMutation(() => this.removeUnlocked(id, force))
  }

  private async removeUnlocked(id: string, force: boolean): Promise<void> {
    this.assertId(id)
    const worktree = this.worktrees.get(id)
    if (!worktree) {
      // Map entry missing — maybe the in-memory state was lost (session switch,
      // process restart, etc.) but Git state may still exist. Try to clean up.
      const branch = `microcode/${id}`
      const worktrees = await this.git(['worktree', 'list', '--porcelain']).catch(() => '')
      const block = worktrees.split(/\r?\n\r?\n/).find((entry) =>
        entry.split(/\r?\n/).includes(`branch refs/heads/${branch}`)
      )
      const worktreePath = block?.split(/\r?\n/)
        .find((line) => line.startsWith('worktree '))
        ?.slice('worktree '.length)
      if (worktreePath) {
        await this.git(['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath]).catch(() => undefined)
      }
      const branches = await this.git(['branch', '--list', branch]).catch(() => '')
      if (branches.trim()) await this.git(['branch', '-D', branch]).catch(() => undefined)
      return
    }

    const status = await this.status(id)
    const merged = await this.isAncestor(worktree.branch, 'HEAD')
    if (!force && (status.changes.length > 0 || !merged)) {
      throw new Error(
        `Worktree ${id} has unmerged changes. Merge it first or remove it with force=true.`,
      )
    }
    await this.git(['worktree', 'remove', ...(force ? ['--force'] : []), worktree.path])
    await this.git(['branch', '-D', worktree.branch]).catch(() => undefined)
    this.worktrees.delete(id)
  }

  private require(id: string): GitWorkTree {
    this.assertId(id)
    const worktree = this.worktrees.get(id)
    if (!worktree) {
      throw new Error(
        `No worktree record for ${id}. The in-memory state may have been lost. ` +
        `The git branch microcode/${id} may still exist — check \`git branch --list microcode/${id}\` ` +
        `and merge or delete it manually.`,
      )
    }
    return worktree
  }

  private assertId(id: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
      throw new Error(`Invalid worktree ID: ${id}`)
    }
  }

  private async assertMainWorkspaceClean(): Promise<void> {
    const status = await this.git(['status', '--porcelain=v1'])
    if (status.trim()) {
      throw new Error(
        'The main Git workspace has uncommitted changes. Commit or stash them before merging a worktree.',
      )
    }
  }

  private async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await execFileAsync(
        'git',
        ['merge-base', '--is-ancestor', ancestor, descendant],
        { cwd: this.repositoryRoot },
      )
      return true
    } catch (error) {
      const exitCode = (error as { code?: number | string }).code
      if (exitCode === 1) return false
      throw new Error(commandError(error))
    }
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue
      .catch(() => undefined)
      .then(() => this.retryLockedOperation(operation))
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private async retryLockedOperation<T>(operation: () => Promise<T>): Promise<T> {
    const delays = [100, 250, 500]
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation()
      } catch (error) {
        const message = commandError(error)
        const locked = /index\.lock|another git process|could not lock/i.test(message)
        if (!locked || attempt >= delays.length) {
          if (locked) {
            throw new Error(
              `The Git repository is temporarily locked. Wait for the other Git operation to finish and retry. ${message}`,
            )
          }
          throw error
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delays[attempt]))
      }
    }
  }

  private async git(args: string[], cwd = this.repositoryRoot): Promise<string> {
    try {
      const result = await execFileAsync('git', args, {
        cwd,
        maxBuffer: 20 * 1024 * 1024,
      })
      return result.stdout
    } catch (error) {
      throw new Error(commandError(error))
    }
  }
}
