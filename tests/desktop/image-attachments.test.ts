import { describe, expect, test } from 'bun:test'
import { encodePastedImage, getPastedImageFiles } from '../../src/desktop/renderer/image-attachments.ts'

function imageFile(bytes: Uint8Array, type: string, name = ''): File {
  const blob = new Blob([bytes], { type })
  return Object.assign(blob, { name }) as File
}

describe('desktop pasted image attachments', () => {
  test('encodes a supported clipboard image as a Pi image block', async () => {
    const result = await encodePastedImage(imageFile(new Uint8Array([1, 2, 3]), 'image/png'), 2)
    expect(result.name).toBe('Pasted image 2.png')
    expect(result.image).toEqual({ type: 'image', mimeType: 'image/png', data: 'AQID' })
  })

  test('keeps clipboard extraction limited to image files and removes duplicates', () => {
    const image = imageFile(new Uint8Array([1]), 'image/png', 'pasted.png')
    const text = imageFile(new Uint8Array([2]), 'text/plain', 'note.txt')
    const clipboard = {
      items: [
        { kind: 'file', type: 'image/png', getAsFile: () => image },
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => image },
      ],
      files: [image, text],
    } as unknown as DataTransfer
    expect(getPastedImageFiles(clipboard)).toEqual([image])
  })

  test('rejects unsupported and oversized clipboard data', async () => {
    await expect(encodePastedImage(imageFile(new Uint8Array([1]), 'image/bmp'))).rejects.toThrow('PNG, JPEG, WebP, or GIF')
    await expect(encodePastedImage(imageFile(new Uint8Array(4 * 1024 * 1024 + 1), 'image/png'))).rejects.toThrow('smaller than 4 MiB')
  })
})
