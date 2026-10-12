import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ApplicationRuntime } from '../../src/runtime/ApplicationRuntime.ts'
import type { RuntimeCommandEnvelope, RuntimeCommandResponse, RuntimeEvent, RuntimeSnapshot } from '../../src/runtime/protocol.ts'
import type { RuntimeFactoryResult } from '../../src/runtime/RuntimeFactory.ts'
import type { GitRepository } from '../../src/git/GitRepository.ts'
import { DesktopBackend } from '../../src/desktop/DesktopBackend.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function fakeRuntime(cwd: string, onClose: () => void = () => undefined): ApplicationRuntime {
  return {
    getSnapshot: () => ({ protocolVersion: 1, sequence: 0, lifecycle: 'ready', project: { cwd }, session: { id: 'session-1', metadata: null, draft: true }, agent: {} as RuntimeSnapshot['agent'], messages: [], mcpServers: [], plugins: null }),
    subscribe: (_listener: (event: RuntimeEvent) => void) => () => undefined,
    dispatch: async (envelope: RuntimeCommandEnvelope) => ({ protocolVersion: 1, commandId: envelope.commandId, ok: true, result: undefined }) as RuntimeCommandResponse,
    close: async () => onClose(),
  } as unknown as ApplicationRuntime
}

async function createGitWorkspace(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'microcode-desktop-review-'))
  git(cwd, 'init', '--initial-branch=main')
  git(cwd, 'config', 'user.name', 'Microcode Test')
  git(cwd, 'config', 'user.email', 'microcode-test@example.invalid')
  await writeFile(join(cwd, 'modified.txt'), 'original line\n')
  await writeFile(join(cwd, 'deleted.txt'), 'remove me\n')
  await writeFile(join(cwd, 'rename-old.txt'), 'rename this\n')
  await writeFile(join(cwd, 'large.txt'), 'original large content\n')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'initial')
  return cwd
}

function backendFor(cwd: string, openGitRepository?: (root: string) => Promise<GitRepository>, onClose?: () => void): DesktopBackend {
  return new DesktopBackend(
    async (projectPath) => ({ runtime: fakeRuntime(projectPath, onClose), startupWarnings: [], mcpReady: Promise.resolve() } satisfies RuntimeFactoryResult),
    openGitRepository,
  )
}

describe('desktop workspace review', () => {
  test('validates selected directories before runtime startup and preserves an open project after an invalid switch', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'microcode-desktop-workspace-'))
    const valid = join(parent, 'valid-project')
    await mkdir(valid)
    const filePath = join(parent, 'not-a-folder.txt')
    await writeFile(filePath, 'file')
    let runtimeStarts = 0
    let runtimeCloses = 0
    const backend = new DesktopBackend(async (cwd) => {
      runtimeStarts++
      return { runtime: fakeRuntime(cwd, () => { runtimeCloses++ }), startupWarnings: [], mcpReady: Promise.resolve() } satisfies RuntimeFactoryResult
    })

    try {
      await expect(backend.handle('workspace.open', { cwd: join(parent, 'missing') })).rejects.toMatchObject({ code: 'workspace_unavailable' })
      await expect(backend.handle('workspace.open', { cwd: filePath })).rejects.toMatchObject({ code: 'workspace_unavailable' })
      expect(runtimeStarts).toBe(0)

      const opened = await backend.handle('workspace.open', { cwd: valid }) as { workspace: string }
      expect(opened.workspace).toBe(resolve(valid))
      await expect(backend.handle('workspace.open', { cwd: join(parent, 'missing') })).rejects.toMatchObject({ code: 'workspace_unavailable' })
      expect(backend.getSnapshot().workspace).toBe(resolve(valid))
      expect(runtimeStarts).toBe(1)
      expect(runtimeCloses).toBe(0)
    } finally {
      await backend.close()
      await rm(parent, { recursive: true, force: true })
    }
    expect(runtimeCloses).toBe(1)
  })

  test('shows Git as unavailable for a non-repository folder', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'microcode-desktop-nonrepo-'))
    const backend = backendFor(cwd)
    try {
      await backend.handle('workspace.open', { cwd })
      await expect(backend.handle('review.status')).resolves.toMatchObject({
        available: false,
        changes: [],
        message: expect.stringContaining('Not inside a Git repository'),
      })
    } finally {
      await backend.close()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('maps staged, unstaged, deleted, untracked, and renamed paths and returns each text diff', async () => {
    const cwd = await createGitWorkspace()
    const backend = backendFor(cwd)
    try {
      await writeFile(join(cwd, 'modified.txt'), 'staged line\n')
      git(cwd, 'add', 'modified.txt')
      await writeFile(join(cwd, 'modified.txt'), 'unstaged line\n')
      git(cwd, 'mv', 'rename-old.txt', 'rename-new.txt')
      git(cwd, 'rm', 'deleted.txt')
      await mkdir(join(cwd, 'src'))
      await writeFile(join(cwd, 'src', 'new.ts'), 'export const ready = true\n')
      await backend.handle('workspace.open', { cwd })

      const review = await backend.handle('review.status') as { available: boolean; changes: Array<{ path: string; status: string; staged: boolean; unstaged: boolean; untracked: boolean }> }
      expect(review.available).toBe(true)
      expect(review.changes.find((change) => change.path === 'modified.txt')).toMatchObject({ status: 'MM', staged: true, unstaged: true })
      expect(review.changes.find((change) => change.path === 'deleted.txt')).toMatchObject({ staged: true, status: 'D' })
      expect(review.changes.find((change) => change.path === 'src/new.ts')).toMatchObject({ untracked: true, status: '??' })
      expect(review.changes.find((change) => change.path === 'rename-new.txt')).toMatchObject({ staged: true, status: 'R', previousPath: 'rename-old.txt' })
      expect(review.changes.some((change) => change.path === 'rename-old.txt')).toBe(false)

      const modified = await backend.handle('review.diff', { path: 'modified.txt' }) as { text: string; binary: boolean; truncated: boolean }
      expect(modified).toMatchObject({ binary: false, truncated: false })
      expect(modified.text).toContain('Staged changes')
      expect(modified.text).toContain('Unstaged changes')
      expect(modified.text).toContain('+unstaged line')

      const untracked = await backend.handle('review.diff', { path: 'src/new.ts' }) as { text: string; binary: boolean }
      expect(untracked).toMatchObject({ binary: false })
      expect(untracked.text).toContain('export const ready = true')

      const renamed = await backend.handle('review.diff', { path: 'rename-new.txt' }) as { text: string }
      expect(renamed.text).toContain('rename from rename-old.txt')
      expect(renamed.text).toContain('rename to rename-new.txt')

      const deleted = await backend.handle('review.diff', { path: 'deleted.txt' }) as { text: string }
      expect(deleted.text).toContain('-remove me')
    } finally {
      await backend.close()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('explains oversized and binary files without returning their contents', async () => {
    const cwd = await createGitWorkspace()
    const backend = backendFor(cwd)
    try {
      await writeFile(join(cwd, 'large.txt'), 'changed content '.repeat(45_000))
      await writeFile(join(cwd, 'oversized-untracked.txt'), 'large untracked content '.repeat(12_000))
      await writeFile(join(cwd, 'image.bin'), Buffer.from([0, 1, 2, 3, 255]))
      await backend.handle('workspace.open', { cwd })

      const largeDiff = await backend.handle('review.diff', { path: 'large.txt' }) as { text: string; truncated: boolean }
      expect(largeDiff.truncated).toBe(true)
      expect(largeDiff.text).toContain('[Diff truncated at 512 KiB]')

      const oversized = await backend.handle('review.diff', { path: 'oversized-untracked.txt' }) as { text: string; truncated: boolean }
      expect(oversized.truncated).toBe(false)
      expect(oversized.text).toContain('larger than 256 KiB')
      expect(oversized.text).not.toContain('large untracked content')

      const binary = await backend.handle('review.diff', { path: 'image.bin' }) as { text: string; binary: boolean }
      expect(binary).toMatchObject({ binary: true, text: 'Binary file; preview is not available.' })
    } finally {
      await backend.close()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('surfaces Git failures instead of reporting a successful review', async () => {
    const cwd = await createGitWorkspace()
    const backend = backendFor(cwd, async () => ({
      root: cwd,
      status: async () => { throw new Error('Git status failed after repository changed') },
      diff: async () => '',
    }) as unknown as GitRepository)
    try {
      await backend.handle('workspace.open', { cwd })
      await expect(backend.handle('review.status')).resolves.toMatchObject({
        available: false,
        changes: [],
        message: 'Git status failed after repository changed',
      })
      await expect(backend.handle('review.diff', { path: 'modified.txt' })).rejects.toThrow('Git status failed after repository changed')
    } finally {
      await backend.close()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('rejects traversal paths and files that are no longer changed', async () => {
    const cwd = await createGitWorkspace()
    const backend = backendFor(cwd)
    try {
      await backend.handle('workspace.open', { cwd })
      await expect(backend.handle('review.diff', { path: '../outside.txt' })).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(backend.handle('review.diff', { path: 'modified.txt' })).rejects.toMatchObject({ code: 'invalid_request' })
    } finally {
      await backend.close()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('rejects untracked symlinks that resolve outside the repository', async () => {
    const cwd = await createGitWorkspace()
    const outside = mkdtempSync(join(tmpdir(), 'microcode-desktop-outside-'))
    const outsideFile = join(outside, 'private.txt')
    await writeFile(outsideFile, 'outside content')
    await symlink(outsideFile, join(cwd, 'linked.txt'))
    const backend = backendFor(cwd)
    try {
      await backend.handle('workspace.open', { cwd })
      await expect(backend.handle('review.diff', { path: 'linked.txt' })).rejects.toMatchObject({ code: 'invalid_request' })
    } finally {
      await backend.close()
      await rm(cwd, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
