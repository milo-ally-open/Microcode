import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { GitBranchReader } from '../../src/git/GitBranchReader.ts'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

describe('GitBranchReader', () => {
  test('reads branch changes after the process switches branches', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'microcode-git-branch-'))
    try {
      git(cwd, 'init', '--initial-branch=main')
      git(cwd, 'config', 'user.name', 'Microcode Test')
      git(cwd, 'config', 'user.email', 'microcode-test@example.invalid')
      await writeFile(join(cwd, 'README.md'), 'test\n')
      git(cwd, 'add', 'README.md')
      git(cwd, 'commit', '-m', 'initial')
      git(cwd, 'checkout', '-b', 'feat_test')

      const reader = new GitBranchReader(cwd)
      expect(reader.getBranch()).toBe('feat_test')

      git(cwd, 'checkout', 'main')
      expect(reader.refresh()).toBe('main')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('refreshes automatically after its cached reading expires', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'microcode-git-branch-'))
    try {
      git(cwd, 'init', '--initial-branch=main')
      git(cwd, 'config', 'user.name', 'Microcode Test')
      git(cwd, 'config', 'user.email', 'microcode-test@example.invalid')
      await writeFile(join(cwd, 'README.md'), 'test\n')
      git(cwd, 'add', 'README.md')
      git(cwd, 'commit', '-m', 'initial')
      git(cwd, 'checkout', '-b', 'feat_test')

      const reader = new GitBranchReader(cwd, 0)
      expect(reader.getBranch()).toBe('feat_test')

      git(cwd, 'checkout', 'main')
      expect(reader.getBranch()).toBe('main')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
