import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { constants, createReadStream } from 'fs'
import { access, open, readFile, stat } from 'fs/promises'
import { isAbsolute, resolve } from 'path'
import { createInterface } from 'readline'
import { Type, type Static } from 'typebox'
import type { PermissionBehavior } from '../../permissions/types.ts'

export const TOOL_NAME = 'read'
export const TOOL_DEFAULT_PERMISSION: PermissionBehavior = 'allow'

export const LARGE_FILE_WARNING_BYTES = 50 * 1024 * 1024
const STREAMING_FILE_BYTES = 200 * 1024 * 1024
const DEFAULT_LIMIT = 2000
export const MENTION_FILE_MAX_BYTES = 64 * 1024
const TEXT_EXTENSIONS = new Set([
  'c', 'cc', 'cfg', 'conf', 'cpp', 'cs', 'css', 'csv', 'go', 'h', 'hpp', 'html', 'ini', 'java',
  'js', 'jsx', 'json', 'kt', 'log', 'md', 'mdx', 'mjs', 'mts', 'php', 'py', 'rb', 'rs', 'sh',
  'sql', 'svelte', 'swift', 'toml', 'ts', 'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml', 'zsh',
])
const TEXT_BASENAMES = new Set([
  '.dockerignore', '.editorconfig', '.env', '.gitignore', 'dockerfile', 'makefile', 'readme',
])

const readSchema = Type.Object({
  file_path: Type.String({ description: 'Path to the file to read (relative or absolute)' }),
  offset: Type.Optional(
    Type.Number({ description: 'Line number to start reading from (1-indexed)' }),
  ),
  limit: Type.Optional(
    Type.Number({ description: 'Maximum number of lines to read (default 2000)' }),
  ),
})

export type FileReadToolInput = Static<typeof readSchema>

export interface FileReadToolDetails {
  path: string
  totalLines: number
  returnedLines: number
  truncated: boolean
  /** 原始预览数据；行号只由 TUI 展示层添加，不进入模型内容。 */
  previewLines?: string[]
  previewStartLine?: number
  warning?: string
  continuation?: string
}

function hasTextExtension(filePath: string): boolean {
  const baseName = filePath.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  const extension = baseName.includes('.') ? baseName.split('.').at(-1) ?? '' : ''
  return TEXT_BASENAMES.has(baseName) || TEXT_EXTENSIONS.has(extension)
}

export function supportsMentionedTextFile(filePath: string): boolean {
  return hasTextExtension(filePath)
}

function decodeTextBytes(bytes: Uint8Array, streaming = false): string | undefined {
  if (bytes.includes(0)) return undefined
  const sample = Buffer.from(bytes.subarray(0, 1024)).toString('latin1')
  const prefix = sample.slice(0, 16)
  if (
    /^\s*%PDF-/.test(sample) || prefix.startsWith('PK\x03\x04') || prefix.startsWith('PK\x05\x06') ||
    prefix.startsWith('PK\x07\x08') || prefix.startsWith('\x7fELF') || prefix.startsWith('SQLite format 3') ||
    prefix.startsWith('\x1f\x8b') || prefix.startsWith('\xd0\xcf\x11\xe0') || prefix.startsWith('7z\xbc\xaf\x27\x1c') ||
    prefix.startsWith('Rar!') || prefix.startsWith('\x89PNG\r\n\x1a\n') || prefix.startsWith('\xff\xd8\xff') ||
    prefix.startsWith('GIF8') || prefix.startsWith('RIFF') || prefix.startsWith('BM')
  ) return undefined
  for (const byte of bytes) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return undefined
    if (byte === 0x7f) return undefined
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: streaming })
  } catch {
    return undefined
  }
}

async function assertTextFile(filePath: string): Promise<void> {
  if (!hasTextExtension(filePath)) {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)
    const tip = isImage ? ' Use the vision tool to analyze image files.' : ''
    throw new Error(`Cannot read binary file or unsupported format: ${filePath}.${tip}`)
  }
  const handle = await open(filePath, 'r')
  try {
    const sample = Buffer.alloc(512)
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0)
    if (decodeTextBytes(sample.subarray(0, bytesRead), true) !== undefined) return
    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)
    const tip = isImage ? ' Use the vision tool to analyze image files.' : ''
    throw new Error(`Cannot read binary or invalid text file: ${filePath}.${tip}`)
  } finally {
    await handle.close()
  }
}

/** Safely read a bounded prefix for explicit @file context; unsupported/invalid formats return undefined. */
export async function readMentionedTextFile(
  cwd: string,
  relativePath: string,
  maxBytes = MENTION_FILE_MAX_BYTES,
): Promise<{ content: string; truncated: boolean } | undefined> {
  if (!hasTextExtension(relativePath)) return undefined
  const filePath = resolve(cwd, relativePath)
  const relativePathCheck = filePath.slice(resolve(cwd).length).replace(/^[\\/]/, '')
  if (!relativePathCheck || relativePathCheck.startsWith('..') || isAbsolute(relativePathCheck)) return undefined
  await access(filePath, constants.R_OK)
  const fileStat = await stat(filePath)
  if (!fileStat.isFile()) return undefined
  const handle = await open(filePath, 'r')
  try {
    const bytes = Buffer.alloc(Math.max(1, maxBytes) + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const truncated = bytesRead > maxBytes || fileStat.size > maxBytes
    const visibleBytes = bytes.subarray(0, Math.min(bytesRead, maxBytes))
    if (decodeTextBytes(visibleBytes, truncated) === undefined) return undefined
    const content = new TextDecoder('utf-8', { fatal: true }).decode(visibleBytes, { stream: truncated })
    return { content, truncated }
  } finally {
    await handle.close()
  }
}

async function readStreamedLines(
  filePath: string,
  offset: number,
  limit: number,
): Promise<{
  lines: string[]
  observedLines: number
  truncated: boolean
}> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  const lines: string[] = []
  let observedLines = 0
  let truncated = false

  try {
    for await (const line of reader) {
      observedLines++
      if (observedLines < offset) continue
      if (lines.length < limit) {
        lines.push(line)
        continue
      }
      truncated = true
      break
    }
  } finally {
    reader.close()
    stream.destroy()
  }

  return { lines, observedLines, truncated }
}

export function createFileReadTool(
  cwd: string,
): AgentTool<typeof readSchema, FileReadToolDetails> {
  return {
    name: TOOL_NAME,
    label: 'Read',
    description:
      'Read the contents of a text file. Returns file content with line numbers. Use offset and limit for large files. Do NOT use for images, binaries, or non-text files; use the vision tool for images instead.',
    parameters: readSchema,
    async execute(
      _toolCallId: string,
      params: FileReadToolInput,
      _signal?: AbortSignal,
      onUpdate?: (partial: AgentToolResult<FileReadToolDetails>) => void,
    ): Promise<AgentToolResult<FileReadToolDetails>> {
      const filePath = isAbsolute(params.file_path)
        ? params.file_path
        : resolve(cwd, params.file_path)

      await access(filePath, constants.R_OK)
      const fileStat = await stat(filePath)
      if (fileStat.isDirectory()) {
        throw new Error(
          `Cannot read directory: ${filePath}. Use glob to list files or read a specific file.`,
        )
      }
      await assertTextFile(filePath)

      const offset = Math.max(1, params.offset ?? 1)
      const limit = Math.max(0, params.limit ?? DEFAULT_LIMIT)
      const warning = fileStat.size > LARGE_FILE_WARNING_BYTES
        ? `Warning: large file (${(fileStat.size / 1024 / 1024).toFixed(1)} MB). Output is limited; use offset and limit to read it in sections.`
        : undefined

      let selectedLines: string[]
      let totalLines: number
      let truncated: boolean
      let continuation: string | undefined

      if (fileStat.size > STREAMING_FILE_BYTES) {
        const streamed = await readStreamedLines(filePath, offset, limit)
        selectedLines = streamed.lines
        totalLines = streamed.observedLines
        truncated = streamed.truncated
        if (truncated) {
          continuation =
            `... (more lines remain; streaming stopped early. Use offset=${offset + selectedLines.length} to continue)`
        }
      } else {
        const content = await readFile(filePath, 'utf8')
        const allLines = content.split('\n')
        totalLines = allLines.length
        const startIndex = offset - 1
        const endIndex = Math.min(startIndex + limit, totalLines)
        selectedLines = allLines.slice(startIndex, endIndex)
        truncated = endIndex < totalLines
        if (truncated) {
          continuation =
            `... (${totalLines - endIndex} more lines, ${totalLines} total. Use offset=${endIndex + 1} to continue)`
        }
      }

      onUpdate?.({
        content: [{ type: 'text', text: `Reading ${filePath}...` }],
        details: {
          path: filePath,
          totalLines,
          returnedLines: selectedLines.length,
          truncated,
        },
      })

      const sections: string[] = []
      if (warning) sections.push(warning)
      if (selectedLines.length > 0) sections.push(selectedLines.join('\n'))
      if (continuation) sections.push(continuation)

      return {
        content: [{ type: 'text', text: sections.join('\n\n') }],
        details: {
          path: filePath,
          totalLines,
          returnedLines: selectedLines.length,
          truncated,
          previewLines: selectedLines,
          previewStartLine: offset,
          warning,
          continuation,
        },
      }
    },
  }
}
