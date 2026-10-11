import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { compileBinaryAtomically } from '../../packaging/build-compile.ts'

describe('staged binary compilation', () => {
  test('repeated builds compile separately and replace the previous output only after success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'microcode-compile-'))
    const destination = join(root, 'microcode.exe')
    await writeFile(destination, 'previous executable')
    try {
      for (const content of ['first build', 'second build']) {
        const previous = await readFile(destination, 'utf8')
        const result = await compileBinaryAtomically(destination, async (outputPath) => {
          expect(outputPath).not.toBe(destination)
          expect(dirname(outputPath)).not.toBe(root)
          expect(basename(outputPath)).toBe('microcode.exe')
          expect(await readFile(destination, 'utf8')).toBe(previous)
          await writeFile(outputPath, content)
          return content
        })
        expect(result).toBe(content)
        expect(await readFile(destination, 'utf8')).toBe(content)
        expect(await readdir(root)).toEqual(['microcode.exe'])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('compile and replacement failures preserve the old executable and clean staging files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'microcode-compile-failure-'))
    const destination = join(root, 'microcode.exe')
    await writeFile(destination, 'previous executable')
    try {
      await expect(compileBinaryAtomically(destination, async (outputPath) => {
        await writeFile(outputPath, 'partial build')
        throw new Error('compiler failed')
      })).rejects.toThrow('compiler failed')
      expect(await readFile(destination, 'utf8')).toBe('previous executable')
      expect(await readdir(root)).toEqual(['microcode.exe'])

      await expect(compileBinaryAtomically(destination, async (outputPath) => {
        await writeFile(outputPath, 'complete build')
      }, async () => {
        throw Object.assign(new Error('executable is locked'), { code: 'EPERM' })
      })).rejects.toThrow('executable is locked')
      expect(await readFile(destination, 'utf8')).toBe('previous executable')
      expect(await readdir(root)).toEqual(['microcode.exe'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
