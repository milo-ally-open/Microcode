import { createHash, randomUUID } from 'crypto'
import { createReadStream } from 'fs'
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { dirname } from 'path'

export interface InstallFileOperations {
  copyFile(source: string, destination: string): void
  rename(source: string, destination: string): void
  unlink(path: string): void
  exists(path: string): boolean
  hash(path: string): Promise<string>
  makeTemporaryPath(destination: string): string
}

const defaultOperations: InstallFileOperations = {
  copyFile: copyFileSync,
  rename: renameSync,
  unlink: unlinkSync,
  exists: existsSync,
  hash: (filePath) => new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  }),
  makeTemporaryPath: (destination) => `${destination}.tmp-${process.pid}-${randomUUID()}`,
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function isReplacementLock(error: unknown): boolean {
  return ['EACCES', 'EBUSY', 'EPERM', 'ERROR_SHARING_VIOLATION', 'ERROR_ACCESS_DENIED'].includes(errorCode(error) ?? '')
}

/**
 * Install by preparing a complete sibling file, then renaming it over the target.
 * If replacement fails (for example, Windows has the old executable open), the
 * existing target is left untouched and the failure is surfaced to the caller.
 */
export async function installBinaryAtomically(
  source: string,
  destination: string,
  operations: InstallFileOperations = defaultOperations,
  prepareTemporaryFile?: (path: string) => void,
): Promise<void> {
  mkdirSync(dirname(destination), { recursive: true })
  const temporaryPath = operations.makeTemporaryPath(destination)
  let installError: unknown

  try {
    operations.copyFile(source, temporaryPath)
    prepareTemporaryFile?.(temporaryPath)
    if (await operations.hash(source) !== await operations.hash(temporaryPath)) {
      throw new Error('The temporary install file does not match the compiled binary.')
    }

    operations.rename(temporaryPath, destination)

    if (await operations.hash(source) !== await operations.hash(destination)) {
      throw new Error('The installed executable does not match the compiled binary.')
    }
    return
  } catch (error) {
    installError = error
  }

  let cleanupError: unknown
  try {
    if (operations.exists(temporaryPath)) operations.unlink(temporaryPath)
  } catch (error) {
    cleanupError = error
  }

  const detail = installError instanceof Error ? installError.message : String(installError)
  const message = isReplacementLock(installError)
    ? `The operating system refused to replace the installed executable at ${destination} (often because a Microcode process still has it open). Run "microcode gateway stop" and close any running Microcode CLI sessions, then run "bun run build" again. The existing installation was not reported as updated. (${detail})`
    : `Could not install the compiled executable. The existing installation was not reported as updated. (${detail})`
  const cleanupDetail = cleanupError
    ? ` Temporary file cleanup also failed at ${temporaryPath}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
    : ''
  throw new Error(`${message}${cleanupDetail}`)
}

export interface PathDiagnosis {
  normalizedCandidates: string[]
  canonicalIndex: number
  shadowingCandidates: string[]
  canonicalIsOnPath: boolean
}

function normalizeWindowsPath(value: string): string {
  // where.exe normally returns absolute paths.
  const normalized = value.trim().replace(/^"|"$/g, '').replaceAll('/', '\\')
  return normalized.replace(/\\+/g, '\\').replace(/\\$/, '').toLowerCase()
}

export function diagnoseWindowsPath(
  installPath: string,
  commandCandidates: string[],
): PathDiagnosis {
  const canonical = normalizeWindowsPath(installPath)
  const normalizedCandidates = commandCandidates
    .map(normalizeWindowsPath)
    .filter(Boolean)
  const canonicalIndex = normalizedCandidates.indexOf(canonical)
  return {
    normalizedCandidates,
    canonicalIndex,
    shadowingCandidates: canonicalIndex < 0 ? normalizedCandidates : normalizedCandidates.slice(0, canonicalIndex),
    canonicalIsOnPath: canonicalIndex >= 0,
  }
}
