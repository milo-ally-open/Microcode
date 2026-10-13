import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { indexReleaseFiles, verifyReleaseFiles } from '../../packaging/desktop/windows/manifest.ts'

describe('desktop release manifest inventory', () => {
  test('records sorted portable paths and verifies hashes and sizes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'microcode-release-manifest-'))
    try {
      await mkdir(join(root, 'resources/app'), { recursive: true })
      await writeFile(join(root, 'resources/app/main.mjs'), 'export const ready = true\n')
      await writeFile(join(root, 'Microcode.exe'), 'electron-runtime')

      const files = await indexReleaseFiles(root)
      expect(files.map((file) => file.path)).toEqual(['Microcode.exe', 'resources/app/main.mjs'])
      expect(files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256) && file.size > 0)).toBe(true)
      await expect(verifyReleaseFiles(root, files)).resolves.toBeUndefined()

      await writeFile(join(root, 'resources/app/main.mjs'), 'tampered')
      await expect(verifyReleaseFiles(root, files)).rejects.toThrow('integrity check failed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects extra files, duplicate entries, and paths that escape the package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'microcode-release-inventory-'))
    try {
      await writeFile(join(root, 'Microcode.exe'), 'electron-runtime')
      const files = await indexReleaseFiles(root)
      await writeFile(join(root, 'unlisted.txt'), 'extra')
      await expect(verifyReleaseFiles(root, files)).rejects.toThrow('inventory mismatch')

      await expect(verifyReleaseFiles(root, [
        { ...files[0]!, path: '../outside.exe' },
      ])).rejects.toThrow('Invalid or duplicate release manifest path')
      await expect(verifyReleaseFiles(root, [files[0]!, files[0]!])).rejects.toThrow('Invalid or duplicate release manifest path')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
