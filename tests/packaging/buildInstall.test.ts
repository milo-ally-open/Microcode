import { createHash, randomUUID } from 'crypto'
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  diagnoseWindowsPath,
  installBinaryAtomically,
  type InstallFileOperations,
} from '../../packaging/build-install.ts'

function memoryFiles(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial))
  const operations: InstallFileOperations = {
    copyFile: (source, destination) => {
      const value = files.get(source)
      if (value === undefined) throw new Error(`Missing source: ${source}`)
      files.set(destination, value)
    },
    rename: (source, destination) => {
      const value = files.get(source)
      if (value === undefined) throw new Error(`Missing temporary file: ${source}`)
      files.set(destination, value)
      files.delete(source)
    },
    unlink: (filePath) => { files.delete(filePath) },
    exists: (filePath) => files.has(filePath),
    hash: async (filePath) => {
      const value = files.get(filePath)
      if (value === undefined) throw new Error(`Missing file: ${filePath}`)
      return createHash('sha256').update(value).digest('hex')
    },
    makeTemporaryPath: (destination) => `${destination}.temp-test`,
  }
  return { files, operations }
}

describe('binary build installation', () => {
  test('repeated builds replace an existing canonical executable completely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'microcode-install-'))
    const source = join(root, 'dist', 'microcode.exe')
    const destination = join(root, 'local', 'microcode', 'bin', 'microcode.exe')
    await mkdir(join(root, 'dist'), { recursive: true })
    await mkdir(join(root, 'local', 'microcode', 'bin'), { recursive: true })
    await writeFile(source, 'new complete executable')
    await writeFile(destination, 'old executable')

    try {
      await installBinaryAtomically(source, destination)
      expect(await readFile(destination, 'utf8')).toBe('new complete executable')
      expect(await readdir(join(root, 'local', 'microcode', 'bin'))).toEqual(['microcode.exe'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('replacement failure from a locked executable preserves the old file and removes its temp file', async () => {
    const source = 'compiled.exe'
    const destination = join(tmpdir(), `microcode-locked-${randomUUID()}.exe`)
    const temporary = `${destination}.temp-test`
    const { files, operations } = memoryFiles({ [source]: 'new build', [destination]: 'old installed build' })
    operations.rename = () => { throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' }) }

    await expect(installBinaryAtomically(source, destination, operations)).rejects.toThrow(
      'The operating system refused to replace the installed executable',
    )
    expect(files.get(destination)).toBe('old installed build')
    expect(files.has(temporary)).toBe(false)
  })

  test('reports cleanup failure instead of hiding a leftover temporary file', async () => {
    const source = 'compiled.exe'
    const destination = join(tmpdir(), `microcode-cleanup-${randomUUID()}.exe`)
    const temporary = `${destination}.temp-test`
    const { files, operations } = memoryFiles({ [source]: 'new build', [destination]: 'old build' })
    operations.rename = () => { throw Object.assign(new Error('access denied'), { code: 'EPERM' }) }
    operations.unlink = () => { throw new Error('cleanup denied') }

    await expect(installBinaryAtomically(source, destination, operations)).rejects.toThrow(
      `Temporary file cleanup also failed at ${temporary}: cleanup denied`,
    )
    expect(files.get(destination)).toBe('old build')
    expect(files.has(temporary)).toBe(true)
  })
})

describe('Windows executable PATH diagnosis', () => {
  const canonical = 'C:\\Users\\sample\\AppData\\Local\\microcode\\bin\\microcode.exe'

  test('detects older executable hits before the canonical install', () => {
    const result = diagnoseWindowsPath(canonical, [
      'C:\\Program Files\\Microcode\\microcode.exe',
      'c:/users/sample/appdata/local/microcode/bin/microcode.exe',
    ])

    expect(result.canonicalIsOnPath).toBe(true)
    expect(result.canonicalIndex).toBe(1)
    expect(result.shadowingCandidates).toEqual(['c:\\program files\\microcode\\microcode.exe'])
  })

  test('reports missing canonical hit and recognizes the canonical first hit', () => {
    expect(diagnoseWindowsPath(canonical, ['C:\\Legacy\\microcode.exe']).canonicalIsOnPath).toBe(false)
    const first = diagnoseWindowsPath(canonical, [canonical, 'C:\\Legacy\\microcode.exe'])
    expect(first.shadowingCandidates).toEqual([])
    expect(first.canonicalIndex).toBe(0)
  })
})
