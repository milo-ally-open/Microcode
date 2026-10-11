import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { MENTION_FILE_MAX_BYTES, readMentionedTextFile, supportsMentionedTextFile } from '../tools/FileReadTool/FileReadTool.ts'
import { IMAGE_EXTENSION_REGEX } from '../utils/imageUtils.ts'

const IGNORED_DIRECTORIES = new Set([
  '.git', 'node_modules', '.next', '.nuxt', '.turbo', 'dist', 'build', 'coverage',
])

/** List searchable workspace files without following symlinks into other locations. */
export async function listWorkspaceFiles(cwd: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) await visit(fullPath)
      else if (entry.isFile()) files.push(relative(cwd, fullPath).split(sep).join('/'))
    }
  }
  await visit(cwd)
  return files.sort((a, b) => a.localeCompare(b))
}

export function filterWorkspaceFiles(files: readonly string[], query: string): string[] {
  const needle = query.toLocaleLowerCase()
  if (!needle) return [...files]
  return files.filter((file) => file.toLocaleLowerCase().includes(needle))
}

/** Parse @path and @"path with spaces" references. */
export function parseFileMentions(text: string): string[] {
  const paths: string[] = []
  const pattern = /@(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s]+))/g
  for (const match of text.matchAll(pattern)) {
    const raw = match[1] ?? match[2] ?? match[3]
    if (raw) paths.push(raw.replace(/\\([\\"'])/g, '$1'))
  }
  return [...new Set(paths)]
}

export function getMentionedImagePaths(text: string, indexedFiles: ReadonlySet<string>): string[] {
  return parseFileMentions(text).filter((path) => indexedFiles.has(path) && IMAGE_EXTENSION_REGEX.test(path))
}

export function formatFileMention(path: string): string {
  return /\s/.test(path) ? `@"${path.replace(/([\\"])/g, '\\$1')}"` : `@${path}`
}

export function highlightWorkspaceFileMentions(text: string, highlight: (mention: string) => string): string {
  const pattern = /(?<![\w@])@(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|[^\s]+)/g
  return text.replace(pattern, (mention) => highlight(mention))
}

export function applyWorkspaceFileCompletion(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  prefix: string,
  path: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
  const updated = [...lines]
  const currentLine = updated[cursorLine] ?? ''
  const beforePrefix = currentLine.slice(0, cursorCol - prefix.length)
  const afterCursor = currentLine.slice(cursorCol)
  const value = formatFileMention(path)
  updated[cursorLine] = `${beforePrefix}${value} ${afterCursor}`
  return { lines: updated, cursorLine, cursorCol: beforePrefix.length + value.length + 1 }
}

/** Read only recognized UTF-8 text formats, with a strict byte cap. */
export async function readMentionedFile(cwd: string, path: string, maxBytes?: number): Promise<string | undefined> {
  const result = await readMentionedTextFile(cwd, path, maxBytes)
  if (!result) return undefined
  return `### ${path}\n\n${result.content}${result.truncated ? '\n\n[File content truncated at the attachment byte limit.]' : ''}`
}

export async function buildWorkspaceFileContext(
  cwd: string,
  input: string,
  indexedFiles: ReadonlySet<string>,
  authorizeRead: (path: string) => Promise<boolean> = async () => true,
): Promise<string> {
  const sections: string[] = []
  let remainingBytes = MENTION_FILE_MAX_BYTES * 2
  for (const path of parseFileMentions(input)) {
    if (!indexedFiles.has(path) || !supportsMentionedTextFile(path) || remainingBytes <= 0) continue
    if (!await authorizeRead(path)) continue
    const section = await readMentionedFile(cwd, path, Math.min(MENTION_FILE_MAX_BYTES, remainingBytes))
    if (!section) continue
    sections.push(section)
    remainingBytes -= Buffer.byteLength(section, 'utf8')
  }
  if (sections.length === 0) return input
  return `${input}\n\n[Referenced workspace files]\n${sections.join('\n\n')}`
}
