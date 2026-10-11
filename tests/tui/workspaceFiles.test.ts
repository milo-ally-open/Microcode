import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildWorkspaceFileContext,
  applyWorkspaceFileCompletion,
  filterWorkspaceFiles,
  formatFileMention,
  getMentionedImagePaths,
  highlightWorkspaceFileMentions,
  listWorkspaceFiles,
  parseFileMentions,
} from '../../src/tui/workspaceFiles.ts'
import { MENTION_FILE_MAX_BYTES, readMentionedTextFile } from '../../src/tools/FileReadTool/FileReadTool.ts'
import { identifyClipboardImage } from '../../src/utils/clipboardImage.ts'

describe('workspace file mentions', () => {
  test('searches by filename and relative path, selects quoted paths with spaces, and skips ignored directories', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'microcode-mentions-'))
    try {
      await mkdir(join(cwd, 'src', 'shared dir'), { recursive: true })
      await mkdir(join(cwd, '.git', 'objects'), { recursive: true })
      await mkdir(join(cwd, 'node_modules', 'pkg'), { recursive: true })
      await writeFile(join(cwd, 'src', 'shared dir', 'My File.ts'), 'export {}')
      await writeFile(join(cwd, '.git', 'objects', 'ignored'), 'git')
      await writeFile(join(cwd, 'node_modules', 'pkg', 'ignored.js'), 'module')

      const files = await listWorkspaceFiles(cwd)
      expect(filterWorkspaceFiles(files, 'shared dir/my')).toEqual(['src/shared dir/My File.ts'])
      expect(filterWorkspaceFiles(files, 'file.ts')).toEqual(['src/shared dir/My File.ts'])
      expect(formatFileMention('src/shared dir/My File.ts')).toBe('@"src/shared dir/My File.ts"')
      expect(highlightWorkspaceFileMentions(
        'Read @README.md and @"src/shared dir/My File.ts", but ignore a@b.com.',
        (mention) => `[${mention}]`,
      )).toBe('Read [@README.md] and [@"src/shared dir/My File.ts"], but ignore a@b.com.')
      expect(applyWorkspaceFileCompletion(
        ['Check @src/shared'], 0, 'Check @src/shared'.length, '@src/shared', 'src/shared dir/My File.ts',
      )).toMatchObject({ lines: ['Check @"src/shared dir/My File.ts" '], cursorLine: 0 })
      expect(parseFileMentions('Please inspect @"src/shared dir/My File.ts" and @README.md'))
        .toEqual(['src/shared dir/My File.ts', 'README.md'])
      expect(getMentionedImagePaths(
        'Compare @"images/sample photo.png" with @README.md and @outside.jpg',
        new Set(['images/sample photo.png', 'README.md']),
      )).toEqual(['images/sample photo.png'])
      expect(files.some((file) => file.includes('.git') || file.includes('node_modules'))).toBe(false)

      await writeFile(join(cwd, 'new-after-index.txt'), 'new file')
      expect(await listWorkspaceFiles(cwd)).toContain('new-after-index.txt')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('injects multiple text references into this turn context and preserves the user references', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'microcode-mention-context-'))
    try {
      await writeFile(join(cwd, 'one.md'), '# One\nfirst body')
      await writeFile(join(cwd, 'two.txt'), 'second body')
      const input = 'Compare @one.md with @two.txt'
      const context = await buildWorkspaceFileContext(cwd, input, new Set(['one.md', 'two.txt']))
      expect(context).toContain(input)
      expect(context).toContain('### one.md')
      expect(context).toContain('# One\nfirst body')
      expect(context).toContain('### two.txt')
      expect(context).toContain('second body')

      const denied = await buildWorkspaceFileContext(cwd, input, new Set(['one.md', 'two.txt']), async (path) => path !== 'two.txt')
      expect(denied).toContain('@two.txt')
      expect(denied).not.toContain('second body')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('does not inject binary or unsupported document formats, and caps long single-line text by bytes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'microcode-mention-binary-'))
    try {
      await writeFile(join(cwd, 'fake.pdf'), Buffer.from('%PDF-1.7\nplain-looking prefix'))
      await writeFile(join(cwd, 'fake.docx'), Buffer.from('PK\x03\x04document'))
      await writeFile(join(cwd, 'renamed.txt'), Buffer.from('%PDF-1.7\ntext-like prefix'))
      await writeFile(join(cwd, 'invalid.txt'), Buffer.from([0x66, 0x80, 0x67]))
      await writeFile(join(cwd, 'long.txt'), 'x'.repeat(MENTION_FILE_MAX_BYTES * 3))
      const files = new Set(['fake.pdf', 'fake.docx', 'renamed.txt', 'invalid.txt', 'long.txt'])
      const input = 'Use @fake.pdf @fake.docx @renamed.txt @invalid.txt @long.txt'
      const context = await buildWorkspaceFileContext(cwd, input, files)
      expect(context).toContain(input)
      expect(context).not.toContain('%PDF-1.7')
      expect(context).not.toContain('document')
      expect(context).not.toContain('text-like prefix')
      expect(context).not.toContain('### invalid.txt')
      expect(context).toContain('[File content truncated at the attachment byte limit.]')

      const bounded = await readMentionedTextFile(cwd, 'long.txt')
      expect(bounded?.truncated).toBe(true)
      expect(Buffer.byteLength(bounded?.content ?? '', 'utf8')).toBeLessThanOrEqual(MENTION_FILE_MAX_BYTES)
      expect((await readFile(join(cwd, 'long.txt'))).byteLength).toBe(MENTION_FILE_MAX_BYTES * 3)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('clipboard image detection', () => {
  test('accepts supported image signatures and rejects non-image clipboard data', () => {
    expect(identifyClipboardImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(identifyClipboardImage(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg')
    expect(identifyClipboardImage(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(identifyClipboardImage(Buffer.from('RIFF0000WEBP'))).toBe('image/webp')
    expect(identifyClipboardImage(Buffer.from('plain text'))).toBeUndefined()
  })
})
