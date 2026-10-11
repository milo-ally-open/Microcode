import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { countLineChanges, generateDiff, renderChangeSummary, renderDiffPreview, renderFullDiff, renderNewFilePreview } from '../../src/utils/diffUtils.ts'
import { basename, formatBytes, preview, shortUrl } from '../../src/utils/displayUtils.ts'
import { cleanupImageCache, collectImagePathsFromText, getMimeType, isImageFilePath, loadImageFromCache, readImageToBase64, stripImagePathsFromText, tryReadImageFromPath, unquotePath } from '../../src/utils/imageUtils.ts'

describe('utils modules', () => {
  test('display utilities produce compact labels', () => {
    expect(basename('/a/b/file.ts')).toBe('file.ts')
    expect(preview('abcdef', 3)).toBe('abc...')
    expect(formatBytes(1536)).toBe('1.5KB')
    expect(shortUrl('https://example.com/a/b?secret=1')).toBe('example.com/a/b')
  })

  test('diff utilities count and render changed content', () => {
    expect(countLineChanges('a\nb\n', 'a\nc\nd\n')).toEqual({ additions: 2, removals: 1 })
    const diff = generateDiff('old\n', 'new\n', 'file.txt')
    expect(diff.additions).toBe(1)
    expect(diff.removals).toBe(1)
    expect(renderChangeSummary(1, 2)).toContain('+1 line')
    expect(renderNewFilePreview('a\nb\nc', 2).at(-1)).toContain('more line')
    expect(renderDiffPreview(diff.patch, 20).join('\n')).toContain('@@')
    expect(renderFullDiff(diff.patch, 20).join('\n')).toContain('new')
    expect(countLineChanges('a\n'.repeat(600_000), 'b\n'.repeat(600_000))).toEqual({ additions: 600000, removals: 600000 })
  })

  test('image utilities detect, read, collect, and strip image paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'microcode-images-'))
    try {
      const imagePath = join(dir, 'sample.png')
      writeFileSync(imagePath, Buffer.from([1, 2, 3]))

      expect(getMimeType(imagePath)).toBe('image/png')
      expect(getMimeType(join(dir, 'sample.unknown'))).toBe('application/octet-stream')
      expect(unquotePath(`"${imagePath}"`)).toBe(imagePath)
      expect(isImageFilePath(imagePath)).toBe(true)
      expect(readImageToBase64(imagePath)).toEqual({ data: 'AQID', mimeType: 'image/png' })
      expect(tryReadImageFromPath(imagePath)).toMatchObject({ mimeType: 'image/png', fileName: 'sample.png' })
      expect(tryReadImageFromPath(join(dir, 'missing.png'))).toBeNull()
      expect(collectImagePathsFromText(`look "${imagePath}"`)).toEqual([imagePath])
      expect(collectImagePathsFromText(`look ${imagePath} [Image:ignored.png]`)).toEqual([imagePath])
      expect(stripImagePathsFromText(`look "${imagePath}" now`)).toBe('look now')
      expect(stripImagePathsFromText(`look ${imagePath} now`)).toBe('look now')
      expect(loadImageFromCache(imagePath)).toEqual({ data: 'AQID', mimeType: 'image/png' })
      expect(loadImageFromCache(join(dir, 'missing.png'))).toBeNull()
      cleanupImageCache('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
