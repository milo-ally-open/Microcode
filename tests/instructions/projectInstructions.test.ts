import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProjectInstructions } from '../../src/instructions/projectInstructions.ts'
import { buildInitTaskPrompt } from '../../src/instructions/initProjectGuidance.ts'

describe('project instructions', () => {
  test('loads supported files from project root to cwd in deterministic order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'microcode-instructions-'))
    const project = join(root, 'repo')
    const nested = join(project, 'packages', 'app')

    try {
      await mkdir(join(project, '.git'), { recursive: true })
      await mkdir(nested, { recursive: true })
      await writeFile(join(project, 'AGENTS.md'), 'root agents')
      await writeFile(join(project, 'CLAUDE.md'), 'root claude')
      await writeFile(join(project, 'MICRO.md'), 'root micro')
      await writeFile(join(nested, 'CLAUDE.md'), 'nested claude')

      const instructions = await loadProjectInstructions(nested)

      expect(instructions.projectRoot).toBe(project)
      expect(instructions.files.map((file) => file.path)).toEqual([
        join(project, 'AGENTS.md'),
        join(project, 'CLAUDE.md'),
        join(project, 'MICRO.md'),
        join(nested, 'CLAUDE.md'),
      ])
      expect(instructions.files.map((file) => file.content)).toEqual([
        'root agents',
        'root claude',
        'root micro',
        'nested claude',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses only cwd when there is no git root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'microcode-instructions-no-git-'))
    const cwd = join(root, 'project')

    try {
      await mkdir(cwd, { recursive: true })
      await writeFile(join(root, 'AGENTS.md'), 'outside project')
      await writeFile(join(cwd, 'MICRO.md'), 'local instructions')

      const instructions = await loadProjectInstructions(cwd)

      expect(instructions.projectRoot).toBe(cwd)
      expect(instructions.files.map((file) => file.path)).toEqual([join(cwd, 'MICRO.md')])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips empty files and reports unreadable instruction paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'microcode-instructions-invalid-'))

    try {
      await mkdir(join(root, '.git'))
      await writeFile(join(root, 'AGENTS.md'), '')
      await mkdir(join(root, 'CLAUDE.md'))
      await writeFile(join(root, 'MICRO.md'), 'use the repository rules')

      const instructions = await loadProjectInstructions(root)

      expect(instructions.files.map((file) => file.path)).toEqual([join(root, 'MICRO.md')])
      expect(instructions.diagnostics).toHaveLength(1)
      expect(instructions.diagnostics[0]).toContain('CLAUDE.md')
      expect(instructions.diagnostics[0]).toContain('not a regular file')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('enforces the combined byte limit and reports truncation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'microcode-instructions-limit-'))

    try {
      await mkdir(join(root, '.git'))
      await writeFile(join(root, 'AGENTS.md'), '12345678')
      await writeFile(join(root, 'CLAUDE.md'), 'abcdef')
      await writeFile(join(root, 'MICRO.md'), 'later')

      const instructions = await loadProjectInstructions(root, 10)

      expect(instructions.totalBytes).toBe(10)
      expect(instructions.files).toHaveLength(2)
      expect(instructions.files[0]?.truncated).toBe(false)
      expect(instructions.files[1]?.content).toBe('ab')
      expect(instructions.files[1]?.truncated).toBe(true)
      expect(instructions.diagnostics.some((item) => item.includes('truncated'))).toBe(true)
      expect(instructions.diagnostics.some((item) => item.includes('MICRO.md'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('/init targets MICRO.md and requires explicit approval before writing', () => {
    const cwd = join(tmpdir(), 'microcode-init-project')
    const prompt = buildInitTaskPrompt(cwd)

    expect(prompt).toContain(join(cwd, 'MICRO.md'))
    expect(prompt).toContain('safe project file outline')
    expect(prompt).toContain('Do not attempt to write or edit any file')
  })
})
