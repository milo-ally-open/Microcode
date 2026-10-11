import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { basename, extname, join } from 'path'

export const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp|bmp)$/i

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

export interface CachedImage {
  cachePath: string
  fileName: string
  mimeType: string
  base64Data: string
}

export function getMimeType(filePath: string): string {
  const ext = extname(filePath).slice(1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

export function unquotePath(p: string): string {
  let cleaned = p
  // Strip quotes independently — the regex may not capture the closing quote
  if (cleaned.startsWith("'") || cleaned.startsWith('"')) cleaned = cleaned.slice(1)
  if (cleaned.endsWith("'") || cleaned.endsWith('"')) cleaned = cleaned.slice(0, -1)
  return cleaned
}

export function isImageFilePath(text: string): boolean {
  const trimmed = unquotePath(text.trim())
  return IMAGE_EXTENSION_REGEX.test(trimmed) && existsSync(trimmed)
}

export function readImageToBase64(filePath: string): { data: string; mimeType: string } {
  const buf = readFileSync(filePath)
  const mimeType = getMimeType(filePath)
  return { data: buf.toString('base64'), mimeType }
}

export function storeImage(
  base64Data: string,
  mimeType: string,
  sessionId: string,
): { cachePath: string; fileName: string } {
  const dir = join(homedir(), '.microcode', 'image-cache', sessionId)
  mkdirSync(dir, { recursive: true })

  const ext = mimeType.split('/')[1] ?? 'png'
  const fileName = `${randomUUID()}.${ext}`
  const cachePath = join(dir, fileName)

  const buf = Buffer.from(base64Data, 'base64')
  writeFileSync(cachePath, buf)

  return { cachePath, fileName }
}

export function loadImageFromCache(cachePath: string): { data: string; mimeType: string } | null {
  try {
    const buf = readFileSync(cachePath)
    const mimeType = getMimeType(cachePath)
    return { data: buf.toString('base64'), mimeType }
  } catch {
    return null
  }
}

export function tryReadImageFromPath(text: string): { data: string; mimeType: string; fileName: string } | null {
  const trimmed = unquotePath(text.trim())
  if (!IMAGE_EXTENSION_REGEX.test(trimmed) || !existsSync(trimmed)) {
    return null
  }

  try {
    const { data, mimeType } = readImageToBase64(trimmed)
    return { data, mimeType, fileName: basename(trimmed) }
  } catch {
    return null
  }
}

const IMAGE_EXT_PATTERN = 'png|jpe?g|gif|webp|bmp'
const IMAGE_EXT_REGEX_SOURCE = `\\.(?:${IMAGE_EXT_PATTERN})`

// Capture a full quoted path — terminal wraps paths with spaces/special chars in quotes.
const QUOTED_PATH_RE_SOURCE = `'([^']*${IMAGE_EXT_REGEX_SOURCE})'|"([^"]*${IMAGE_EXT_REGEX_SOURCE})"`
const UNQUOTED_PATH_RE_SOURCE = `(?:^|\\s)([^\\s]*${IMAGE_EXT_REGEX_SOURCE}['"]?)`

const QUOTED_PATH_RE = new RegExp(QUOTED_PATH_RE_SOURCE, 'gi')
const UNQUOTED_PATH_RE = new RegExp(UNQUOTED_PATH_RE_SOURCE, 'gi')

export function stripImagePathsFromText(text: string): string {
  // Strip quoted paths first (terminal wraps paths containing spaces in quotes)
  let result = text.replace(QUOTED_PATH_RE, (match, sq, dq) => {
    const candidate = sq ?? dq
    if (candidate && existsSync(candidate)) return ''
    return match
  })

  // Strip unquoted paths (no spaces, or trailing quote from char-by-char drag-drop)
  result = result.replace(UNQUOTED_PATH_RE, (match, captured) => {
    const candidate = unquotePath(captured)
    if (candidate.startsWith('[Image:') || candidate.startsWith('[Image ')) return match
    if (existsSync(candidate)) return match.replace(captured, '')
    return match
  })

  return result.replace(/\s{2,}/g, ' ').trim()
}

export function collectImagePathsFromText(text: string): string[] {
  const paths = new Set<string>()

  // Match quoted paths (terminal wraps paths with spaces/special chars in quotes)
  const qRegex = new RegExp(QUOTED_PATH_RE_SOURCE, 'gi')
  let match: RegExpExecArray | null
  while ((match = qRegex.exec(text)) !== null) {
    const candidate = match[1] ?? match[2]
    if (candidate && existsSync(candidate)) {
      paths.add(candidate)
    }
  }

  // Match unquoted paths (no spaces in path)
  const uRegex = new RegExp(UNQUOTED_PATH_RE_SOURCE, 'gi')
  while ((match = uRegex.exec(text)) !== null) {
    const candidate = unquotePath(match[1])
    if (candidate.startsWith('[Image:') || candidate.startsWith('[Image ')) continue
    if (existsSync(candidate)) {
      paths.add(candidate)
    }
  }

  return Array.from(paths)
}

export function cleanupImageCache(sessionId: string): void {
  if (!sessionId) return
  const dir = join(homedir(), '.microcode', 'image-cache', sessionId)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
}
