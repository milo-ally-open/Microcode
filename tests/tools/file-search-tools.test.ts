import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createFileEditTool } from '../../src/tools/FileEditTool/FileEditTool.ts'
import { createFileReadTool } from '../../src/tools/FileReadTool/FileReadTool.ts'
import { createFileWriteTool, previewFileWrite } from '../../src/tools/FileWriteTool/FileWriteTool.ts'
import { createGlobTool } from '../../src/tools/GlobTool/GlobTool.ts'
import { createGrepTool } from '../../src/tools/GrepTool/GrepTool.ts'
import { globSearch, grepSearch } from '../../src/utils/searchUtils.ts'

async function tempWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'microcode-tools-'))
  await mkdir(join(cwd, 'src'), { recursive: true })
  await writeFile(join(cwd, 'src', 'alpha.ts'), 'export const alpha = 1\nconsole.log(alpha)\n')
  await writeFile(join(cwd, 'src', 'beta.md'), '# Beta\nalpha beta\n')
  return cwd
}

describe('file and search tools', () => {
  test('write, read, and edit tools perform normal file mutations', async () => {
    const cwd = await tempWorkspace()
    try {
      const write = createFileWriteTool(cwd)
      const read = createFileReadTool(cwd)
      const edit = createFileEditTool(cwd)
      const updates: any[] = []

      const writeResult = await write.execute('write', {
        file_path: 'notes/todo.txt',
        content: 'one\ntwo\n',
      }, undefined, (update) => updates.push(update))
      expect(writeResult.details?.written).toBe(true)
      expect(writeResult.details?.isNewFile).toBe(true)
      expect(writeResult.details?.preview).toBe('one\ntwo\n')
      expect(writeResult.details?.diff).toContain('+one')
      expect(writeResult.details?.diff).toContain('+two')
      expect(updates.map((update) => update.details.phase)).toEqual(['preparing', 'writing'])
      expect(updates[1].details.preview).toBe('one\ntwo\n')

      await writeFile(join(cwd, 'notes', 'existing.txt'), 'old line\nkeep line\n')
      const overwritePreview = await previewFileWrite(cwd, {
        file_path: 'notes/existing.txt',
        content: 'new line\nkeep line\n',
      })
      expect(overwritePreview.diff).toContain('-old line')
      expect(overwritePreview.diff).toContain('+new line')

      const overwriteResult = await write.execute('overwrite', {
        file_path: 'notes/existing.txt',
        content: 'new line\nkeep line\n',
      })
      expect(overwriteResult.details?.diff).toContain('-old line')
      expect(overwriteResult.details?.diff).toContain('+new line')

      const readResult = await read.execute('read', {
        file_path: 'notes/todo.txt',
        offset: 2,
        limit: 1,
      })
      expect(readResult.content[0]?.text).toContain('two')
      expect(readResult.content[0]?.text).not.toContain('2\ttwo')
      expect(readResult.details?.returnedLines).toBe(1)
      expect(readResult.details?.previewLines).toEqual(['two'])
      expect(readResult.details?.previewStartLine).toBe(2)

      const editUpdates: any[] = []
      const editResult = await edit.execute('edit', {
        file_path: 'notes/todo.txt',
        old_string: 'two',
        new_string: 'three',
      }, undefined, (update) => editUpdates.push(update))
      expect(editResult.details?.replacements).toBe(1)
      expect(editUpdates.map((update) => update.details.phase)).toEqual(['preparing', 'writing'])
      expect(await readFile(join(cwd, 'notes', 'todo.txt'), 'utf-8')).toBe('one\nthree\n')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('file tools report binary, duplicate edit, and write conflict paths', async () => {
    const cwd = await tempWorkspace()
    try {
      await writeFile(join(cwd, 'image.png'), Buffer.from([0, 1, 2, 3]))
      await expect(createFileReadTool(cwd).execute('read', { file_path: 'image.png' }))
        .rejects.toThrow('Cannot read binary file')

      await writeFile(join(cwd, 'dupe.txt'), 'x x x')
      await expect(createFileEditTool(cwd).execute('edit', {
        file_path: 'dupe.txt',
        old_string: 'x',
        new_string: 'y',
      })).rejects.toThrow('not unique')
      const replaceAll = await createFileEditTool(cwd).execute('edit', {
        file_path: 'dupe.txt',
        old_string: 'x',
        new_string: 'z',
        replace_all: true,
      })
      expect(replaceAll.details?.replacements).toBe(3)
      await expect(createFileEditTool(cwd).execute('edit', {
        file_path: 'dupe.txt',
        old_string: 'missing',
        new_string: 'z',
        replace_all: true,
      })).rejects.toThrow('old_string not found')

      const write = createFileWriteTool(cwd)
      const first = write.execute('w1', { file_path: 'race.txt', content: 'first' })
      const second = write.execute('w2', { file_path: 'race.txt', content: 'second' })
      const results = await Promise.all([first, second])
      expect(results.some((result) => result.details?.written === false)).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('glob and grep tools expose searchUtils results and details', async () => {
    const cwd = await tempWorkspace()
    try {
      const globTool = createGlobTool(cwd)
      const grepTool = createGrepTool(cwd)

      const globResult = await globTool.execute('glob', { pattern: 'src/*.{ts,md}' })
      expect(globResult.details?.numFiles).toBe(2)
      expect(globResult.content[0]?.text).toContain('src/alpha.ts')

      const grepResult = await grepTool.execute('grep', {
        pattern: 'alpha',
        path: 'src',
        output_mode: 'content',
        '-n': true,
        head_limit: 3,
      })
      expect(grepResult.details?.numMatches).toBeGreaterThan(0)
      expect(grepResult.content[0]?.text).toContain('alpha')

      const countResult = await grepSearch(cwd, 'src', 'alpha', { outputMode: 'count', type: 'ts' })
      expect(countResult.output).toContain('alpha.ts')

      const filesResult = await grepSearch(cwd, 'src', 'alpha', { outputMode: 'files_with_matches', glob: '*.md' })
      expect(filesResult.filenames).toEqual(['beta.md'])

      const directGlob = await globSearch(cwd, 'src', '**/*.ts', { maxResults: 1 })
      expect(directGlob.files).toEqual(['alpha.ts'])
      expect((await globTool.execute('glob', { pattern: 'nope-*' })).content[0]?.text).toContain('No files found')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
