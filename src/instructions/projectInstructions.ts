import { open, lstat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

export const PROJECT_INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md', 'MICRO.md'] as const
export const DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES = 32 * 1024

export interface ProjectInstructionFile {
  path: string
  content: string
  bytes: number
  truncated: boolean
}

export interface ProjectInstructions {
  projectRoot: string
  workingDirectory: string
  files: ProjectInstructionFile[]
  diagnostics: string[]
  totalBytes: number
}

async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd)
  while (true) {
    try {
      await lstat(join(current, '.git'))
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(cwd)
      current = parent
    }
  }
}

function getDirectoryChain(root: string, cwd: string): string[] {
  const relativePath = relative(root, cwd)
  const parts = relativePath.split(sep).filter(Boolean)
  const directories = [root]
  let current = root
  for (const part of parts) {
    current = join(current, part)
    directories.push(current)
  }
  return directories
}

async function readInstructionFile(
  filePath: string,
  maxBytes: number,
): Promise<ProjectInstructionFile | undefined> {
  const info = await lstat(filePath)
  if (!info.isFile()) throw new Error('not a regular file')
  if (info.size === 0 || maxBytes <= 0) return undefined

  const byteCount = Math.min(info.size, maxBytes)
  const buffer = Buffer.alloc(byteCount)
  const handle = await open(filePath, 'r')
  let bytesRead = 0
  try {
    while (bytesRead < byteCount) {
      const result = await handle.read(buffer, bytesRead, byteCount - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
  } finally {
    await handle.close()
  }

  if (bytesRead === 0) return undefined
  return {
    path: filePath,
    content: buffer.subarray(0, bytesRead).toString('utf8'),
    bytes: bytesRead,
    truncated: info.size > bytesRead,
  }
}

export async function loadProjectInstructions(
  cwd = process.cwd(),
  maxBytes = DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES,
): Promise<ProjectInstructions> {
  const workingDirectory = resolve(cwd)
  const projectRoot = await findProjectRoot(workingDirectory)
  const files: ProjectInstructionFile[] = []
  const diagnostics: string[] = []
  let totalBytes = 0
  let limitReached = maxBytes <= 0

  for (const directory of getDirectoryChain(projectRoot, workingDirectory)) {
    for (const name of PROJECT_INSTRUCTION_FILE_NAMES) {
      const filePath = join(directory, name)
      if (limitReached) {
        try {
          const info = await lstat(filePath)
          if (info.isFile()) {
            diagnostics.push(`${filePath}: not loaded because the ${maxBytes}-byte instruction limit was reached`)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            diagnostics.push(`${filePath}: skipped (${error instanceof Error ? error.message : String(error)})`)
          }
        }
        continue
      }

      try {
        const file = await readInstructionFile(filePath, maxBytes - totalBytes)
        if (!file) continue
        files.push(file)
        totalBytes += file.bytes
        if (file.truncated) {
          diagnostics.push(`${filePath}: truncated at the ${maxBytes}-byte instruction limit`)
          limitReached = true
        } else if (totalBytes >= maxBytes) {
          limitReached = true
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        diagnostics.push(`${filePath}: skipped (${error instanceof Error ? error.message : String(error)})`)
      }
    }
  }

  return { projectRoot, workingDirectory, files, diagnostics, totalBytes }
}
