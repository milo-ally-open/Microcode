import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { GitRepository } from '../../src/git/GitRepository.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function createRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'microcode-git-repo-'))
  git(cwd, 'init', '--initial-branch=main')
  git(cwd, 'config', 'user.name', 'Microcode Test')
  git(cwd, 'config', 'user.email', 'microcode-test@example.invalid')
  await writeFile(join(cwd, 'first.txt'), 'first\n')
  await writeFile(join(cwd, 'second.txt'), 'second\n')
  await writeFile(join(cwd, 'third.txt'), 'third\n')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'initial')
  return cwd
}

describe('GitRepository', () => {
  test('opens from nested directories and rejects paths outside a repository', async () => {
    const root = await createRepo()
    const outside = await mkdtemp(join(tmpdir(), 'microcode-git-outside-'))
    try {
      const nested = join(root, 'nested', 'child')
      await mkdir(nested, { recursive: true })
      expect((await GitRepository.open(nested)).root).toBe(root)
      await expect(GitRepository.open(outside)).rejects.toThrow('Not inside a Git repository')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('reports staged, unstaged, untracked, renamed, and unusual paths', async () => {
    const root = await createRepo()
    try {
      await writeFile(join(root, 'first.txt'), 'staged\n')
      git(root, 'add', 'first.txt')
      await writeFile(join(root, 'first.txt'), 'staged and unstaged\n')
      await writeFile(join(root, 'file with spaces.txt'), 'new\n')
      git(root, 'mv', 'second.txt', 'renamed file.txt')
      git(root, 'rm', 'third.txt')

      const changes = (await (await GitRepository.open(root)).status()).changes
      expect(changes.find((item) => item.path === 'first.txt')).toMatchObject({ staged: true, unstaged: true })
      expect(changes.find((item) => item.path === 'file with spaces.txt')).toMatchObject({ untracked: true })
      expect(changes.find((item) => item.path === 'renamed file.txt')).toMatchObject({ staged: true })
      expect(changes.some((item) => item.path === 'second.txt')).toBe(false)
      expect(changes.find((item) => item.path === 'third.txt')).toMatchObject({ staged: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('lists, creates, switches, and safely deletes local branches', async () => {
    const root = await createRepo()
    try {
      const repository = await GitRepository.open(root)
      expect(await repository.branches()).toContainEqual({ name: 'main', current: true })
      await repository.createBranch('feature/test')
      expect((await repository.status()).branch).toBe('feature/test')
      await repository.switchBranch('main')
      await repository.deleteBranch('feature/test')
      expect((await repository.branches()).some((branch) => branch.name === 'feature/test')).toBe(false)

      await repository.createBranch('unmerged')
      await writeFile(join(root, 'first.txt'), 'unmerged\n')
      git(root, 'commit', '-am', 'unmerged change')
      await repository.switchBranch('main')
      await expect(repository.deleteBranch('unmerged')).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('stages, unstages, and discards only the named paths', async () => {
    const root = await createRepo()
    try {
      const repository = await GitRepository.open(root)
      await writeFile(join(root, 'first.txt'), 'changed first\n')
      await writeFile(join(root, 'second.txt'), 'changed second\n')
      await writeFile(join(root, 'untracked.txt'), 'untracked\n')
      await repository.stage(['first.txt', 'untracked.txt'])
      let changes = (await repository.status()).changes
      expect(changes.find((item) => item.path === 'first.txt')?.staged).toBe(true)
      expect(changes.find((item) => item.path === 'second.txt')?.staged).toBe(false)

      await repository.unstage(['first.txt', 'untracked.txt'])
      await repository.discard(['second.txt', 'untracked.txt'])
      changes = (await repository.status()).changes
      expect(changes.find((item) => item.path === 'first.txt')?.unstaged).toBe(true)
      expect(changes.find((item) => item.path === 'second.txt')).toBeUndefined()
      expect(changes.find((item) => item.path === 'untracked.txt')).toBeUndefined()
      expect((await readFile(join(root, 'second.txt'), 'utf-8')).replace(/\r\n/g, '\n')).toBe('second\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('commits only staged paths and requires a non-empty message', async () => {
    const root = await createRepo()
    try {
      const repository = await GitRepository.open(root)
      await expect(repository.commit('  ')).rejects.toThrow('Commit message cannot be empty')
      await writeFile(join(root, 'first.txt'), 'staged edit\n')
      await writeFile(join(root, 'second.txt'), 'unstaged edit\n')
      await repository.stage(['first.txt'])
      const commit = await repository.commit('commit staged file')
      expect(commit).toMatch(/^[0-9a-f]+$/)
      const changes = (await repository.status()).changes
      expect(changes.find((item) => item.path === 'first.txt')).toBeUndefined()
      expect(changes.find((item) => item.path === 'second.txt')?.unstaged).toBe(true)
      expect((await repository.history(1))[0]).toContain('commit staged file')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects paths that escape or target the repository root', async () => {
    const root = await createRepo()
    try {
      const repository = await GitRepository.open(root)
      await expect(repository.stage(['..'])).rejects.toThrow('must stay inside the repository')
      await expect(repository.unstage(['.'])).rejects.toThrow('not the repository root')
      await expect(repository.discard([join(root, 'first.txt')])).rejects.toThrow('must stay inside the repository')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('applies and pops stash entries', async () => {
    const root = await createRepo()
    try {
      const repository = await GitRepository.open(root)
      await writeFile(join(root, 'first.txt'), 'stashed edit\n')
      await writeFile(join(root, 'new file.txt'), 'stashed untracked\n')
      await repository.stashPush('saved work')
      const stashes = await repository.stashList()
      expect(stashes[0]).toContain('saved work')
      await repository.stashApply('stash@{0}')
      expect((await readFile(join(root, 'first.txt'), 'utf-8')).replace(/\r\n/g, '\n')).toBe('stashed edit\n')
      expect((await readFile(join(root, 'new file.txt'), 'utf-8')).replace(/\r\n/g, '\n')).toBe('stashed untracked\n')
      await repository.discard(['first.txt', 'new file.txt'])
      await repository.stashApply('stash@{0}', true)
      expect(await repository.stashList()).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('forwards fetch and push failures from Git', async () => {
    const root = await createRepo()
    const remote = await mkdtemp(join(tmpdir(), 'microcode-git-missing-remote-'))
    try {
      const repository = await GitRepository.open(root)
      git(remote, 'init', '--bare')
      git(root, 'remote', 'add', 'origin', remote)
      git(root, 'push', '-u', 'origin', 'main')
      await rm(remote, { recursive: true, force: true })
      await expect(repository.fetch()).rejects.toThrow(/does not appear to be a git repository|No such file/i)
      await expect(repository.push()).rejects.toThrow(/does not appear to be a git repository|No such file/i)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(remote, { recursive: true, force: true })
    }
  })

  test('pulls fast-forward updates and refuses divergent histories', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'microcode-git-remote-'))
    const seed = join(temp, 'seed')
    const remote = join(temp, 'remote.git')
    const left = join(temp, 'left')
    const right = join(temp, 'right')
    try {
      await mkdir(seed)
      git(seed, 'init', '--initial-branch=main')
      git(seed, 'config', 'user.name', 'Microcode Test')
      git(seed, 'config', 'user.email', 'microcode-test@example.invalid')
      await writeFile(join(seed, 'file.txt'), 'base\n')
      git(seed, 'add', '.')
      git(seed, 'commit', '-m', 'base')
      git(temp, 'init', '--bare', remote)
      git(seed, 'remote', 'add', 'origin', remote)
      git(seed, 'push', '-u', 'origin', 'main')
      git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
      git(temp, 'clone', remote, left)
      git(temp, 'clone', remote, right)
      for (const clone of [left, right]) {
        git(clone, 'config', 'user.name', 'Microcode Test')
        git(clone, 'config', 'user.email', 'microcode-test@example.invalid')
      }
      const leftRepository = await GitRepository.open(left)
      const rightRepository = await GitRepository.open(right)
      expect(await rightRepository.status()).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0 })

      await writeFile(join(left, 'file.txt'), 'fast-forward\n')
      git(left, 'commit', '-am', 'remote update')
      await leftRepository.push()
      await rightRepository.fetch()
      expect(await rightRepository.status()).toMatchObject({ ahead: 0, behind: 1 })
      await rightRepository.pull()
      expect((await readFile(join(right, 'file.txt'), 'utf-8')).replace(/\r\n/g, '\n')).toBe('fast-forward\n')

      await writeFile(join(right, 'file.txt'), 'local divergent\n')
      git(right, 'commit', '-am', 'local divergent')
      expect(await rightRepository.status()).toMatchObject({ ahead: 1, behind: 0 })
      await writeFile(join(left, 'file.txt'), 'remote divergent\n')
      git(left, 'commit', '-am', 'remote divergent')
      await leftRepository.push()
      await rightRepository.fetch()
      expect(await rightRepository.status()).toMatchObject({ ahead: 1, behind: 1 })
      await expect(rightRepository.pull()).rejects.toThrow()
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }, 30000)
})
