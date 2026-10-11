import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportSessionJsonl } from '../../src/session/exportSession.ts'

describe('exportSessionJsonl', () => {
  test('copies the original JSONL into a session-specific project archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'microcode-export-'))
    const sourceDirectory = join(root, 'home', '.microcode', 'sessions')
    const projectDirectory = join(root, 'project')
    const sourcePath = join(sourceDirectory, '2026-09-27T10-00-00Z_session%2Fid.jsonl')
    const original = '{"v":4,"kind":"header"}\r\n{"kind":"entry","data":{"text":"hello"}}\r\n'

    try {
      await mkdir(sourceDirectory, { recursive: true })
      await writeFile(sourcePath, original)

      const exportedPath = await exportSessionJsonl(sourcePath, projectDirectory, 'session/id')

      expect(exportedPath).toBe(join(projectDirectory, '.microcode', 'sessions', 'session-session_2Fid.jsonl'))
      expect(await readFile(exportedPath, 'utf8')).toBe(original)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('exports different sessions to separate files even when source names collide', async () => {
    const root = await mkdtemp(join(tmpdir(), 'microcode-export-'))
    const firstSource = join(root, 'first', 'same-name.jsonl')
    const secondSource = join(root, 'second', 'same-name.jsonl')
    const projectDirectory = join(root, 'project')

    try {
      await mkdir(join(root, 'first'), { recursive: true })
      await mkdir(join(root, 'second'), { recursive: true })
      await writeFile(firstSource, '{"session":"first"}\n')
      await writeFile(secondSource, '{"session":"second"}\n')

      const firstExport = await exportSessionJsonl(firstSource, projectDirectory, 'session-one')
      const secondExport = await exportSessionJsonl(secondSource, projectDirectory, 'session-two')

      expect(firstExport).not.toBe(secondExport)
      expect(await readFile(firstExport, 'utf8')).toBe('{"session":"first"}\n')
      expect(await readFile(secondExport, 'utf8')).toBe('{"session":"second"}\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
