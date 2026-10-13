import type { ImageContent } from '@earendil-works/pi-ai'
import type { DesktopImageAttachment } from '../protocol.ts'

export const MAX_DESKTOP_IMAGE_ATTACHMENTS = 4
export const MAX_DESKTOP_IMAGE_BYTES = 4 * 1024 * 1024

const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
})

type ImageFile = Pick<Blob, 'type' | 'size' | 'arrayBuffer'> & Partial<Pick<File, 'name'>>

export function getPastedImageFiles(clipboardData: DataTransfer): readonly File[] {
  const fromItems = Array.from(clipboardData.items)
    .filter((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
  const candidates = fromItems.length ? fromItems : Array.from(clipboardData.files).filter((file) => file.type.toLowerCase().startsWith('image/'))
  return Object.freeze([...new Set(candidates)])
}

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)))
  }
  return btoa(chunks.join(''))
}

export async function encodePastedImage(file: ImageFile, index = 1): Promise<DesktopImageAttachment> {
  const mimeType = file.type.toLowerCase()
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    throw new Error('Paste a PNG, JPEG, WebP, or GIF image.')
  }
  if (file.size === 0 || file.size > MAX_DESKTOP_IMAGE_BYTES) {
    throw new Error('Each image must be smaller than 4 MiB.')
  }
  const name = file.name?.trim() || `Pasted image ${index}.${EXTENSION_BY_MIME[mimeType]}`
  const image: ImageContent = Object.freeze({
    type: 'image',
    mimeType,
    data: encodeBase64(new Uint8Array(await file.arrayBuffer())),
  })
  return Object.freeze({ name, image })
}
